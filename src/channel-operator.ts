import { type Api, Composer, type Context, GrammyError } from "grammy";
import type { BotCommand, User } from "grammy/types";
import { type ChannelJoinQueueJob, enqueueChannelUnbans } from "./channel-join-monitor";
import { isFarmProfile, matchSubscriberRule, type SubscriberRule } from "./channel-join-rules";
import {
  fitMessage,
  formatMoscowTime,
  formatSubscriber,
  OUTCOME_MARKS,
} from "./channel-join-text";
import { createD1ChannelJoinRepository } from "./repository";
import type {
  ChannelJoinOutcome,
  ChannelJoinProfile,
  ChannelJoinRepository,
  RuntimeConfig,
  TelegramUserProfile,
  WorkerEnv,
} from "./types";

const STATS_PERIOD_SECONDS = 24 * 60 * 60;
const RECENT_JOIN_LIMIT = 20;
const CHECKED_JOIN_LIMIT = 5;

const OPERATOR_COMMANDS: BotCommand[] = [
  { command: "stats", description: "Сводка по каналу за 24 часа" },
  { command: "recent", description: "Последние 20 вступлений" },
  { command: "check", description: "Что бот знает о подписчике: /check ID или @ник" },
  { command: "unban", description: "Разбанить и больше не банить: /unban ID или @ник" },
  { command: "unban_hours", description: "Разбанить всех, кого бот забанил за N часов" },
  { command: "pause", description: "Выключить автобаны, алерты останутся" },
  { command: "resume", description: "Включить автобаны" },
];

// The order of the outcomes in the stats and the legend.
const OUTCOME_LABELS: Record<ChannelJoinOutcome, string> = {
  banned: "Забанены",
  ban_failed: "Бан не прошёл",
  checking: "Проверяются",
  unbanned: "Разбанены",
  allowed: "Пропущены",
};
const OUTCOMES = Object.keys(OUTCOME_LABELS) as ChannelJoinOutcome[];

const OUTCOME_LEGEND = OUTCOMES.map(
  (outcome) => `${OUTCOME_MARKS[outcome]} ${OUTCOME_LABELS[outcome].toLowerCase()}`,
).join(" · ");

const RULE_LABELS: Record<SubscriberRule, string> = {
  foreign_script: "бан: имя индийским, арабским или китайским письмом",
  farm_username: "бан: ник по шаблону фермы",
  premium_latin_name: "бан: Premium, имя и фамилия латиницей, 3 цифры в конце ника",
  premium_farm_username: "проверка профиля: Premium и 3 цифры в конце ника",
};

type OperatorDeps = {
  repository: ChannelJoinRepository;
  channelIds: number[];
  ownerUserIds: Set<string>;
  joinQueue: Queue<ChannelJoinQueueJob> | undefined;
};

type Target = { userId: string } | { error: string };

// Commands of the channel operator. They work only in the operator's private
// chat with the bot. Other updates pass through.
export function createChannelOperatorCommands(
  env: WorkerEnv,
  config: RuntimeConfig,
): Composer<Context> {
  const composer = new Composer<Context>();
  const operatorUserId = config.channelOperatorUserId;
  if (operatorUserId === null) {
    return composer;
  }

  const deps: OperatorDeps = {
    repository: createD1ChannelJoinRepository(env.DB),
    channelIds: [...config.monitoredChannelIds].map(Number),
    ownerUserIds: config.ownerUserIds,
    joinQueue: env.CHANNEL_JOIN_QUEUE,
  };
  const operator = composer
    .chatType("private")
    .filter((ctx) => ctx.from.id === operatorUserId);

  operator.command("start", async (ctx) => {
    await ctx.api.setMyCommands(OPERATOR_COMMANDS, {
      scope: { type: "chat", chat_id: operatorUserId },
    });
    await ctx.reply(helpText());
  });

  operator.command("stats", async (ctx) => {
    for (const chatId of deps.channelIds) {
      await ctx.reply(await statsText(chatId, ctx.msg.date, deps));
    }
  });

  operator.command("recent", async (ctx) => {
    for (const chatId of deps.channelIds) {
      await ctx.reply(await recentText(chatId, deps));
    }
  });

  operator.command("check", async (ctx) => {
    const target = await resolveTarget(ctx.match, "check", deps);
    await ctx.reply("error" in target ? target.error : await subscriberText(target.userId, deps));
  });

  operator.command("unban", async (ctx) => {
    const target = await resolveTarget(ctx.match, "unban", deps);
    await ctx.reply("error" in target ? target.error : await unban(target.userId, ctx.api, deps));
  });

  operator.command("unban_hours", async (ctx) => {
    await ctx.reply(await unbanRecentBans(ctx.match, deps));
  });

  operator.command("pause", async (ctx) => {
    await deps.repository.pauseChannelBans(deps.channelIds.map(String));
    await ctx.reply("Автобаны на паузе. Алерты продолжат приходить. /resume включит баны.");
  });

  operator.command("resume", async (ctx) => {
    await deps.repository.resumeChannelBans(deps.channelIds.map(String));
    await ctx.reply("Автобаны снова работают.");
  });

  return composer;
}

function helpText(): string {
  return [
    "Команды для каналов. Они работают только здесь, в личке с ботом.",
    "",
    ...OPERATOR_COMMANDS.map(({ command, description }) => `/${command} — ${description}`),
  ].join("\n");
}

async function statsText(chatId: number, now: number, deps: OperatorDeps): Promise<string> {
  const stats = await deps.repository.getChannelJoinStats(
    String(chatId),
    now - STATS_PERIOD_SECONDS,
  );
  const total = OUTCOMES.reduce((sum, outcome) => sum + stats.outcomes[outcome], 0);

  return [
    `Канал ${chatId}, последние 24 часа.`,
    `Вступили: ${total}`,
    ...OUTCOMES.map(
      (outcome) => `${OUTCOME_MARKS[outcome]} ${OUTCOME_LABELS[outcome]}: ${stats.outcomes[outcome]}`,
    ),
    "",
    `Последний алерт: ${
      stats.lastAlertAt === null
        ? "не было"
        : `${formatMoscowTime(new Date(stats.lastAlertAt * 1000))} МСК`
    }`,
    `Автобаны: ${
      stats.pausedAt === null
        ? "работают"
        : `на паузе с ${formatMoscowTime(new Date(stats.pausedAt))} МСК`
    }`,
  ].join("\n");
}

async function recentText(chatId: number, deps: OperatorDeps): Promise<string> {
  const joins = await deps.repository.listRecentChannelJoins(String(chatId), RECENT_JOIN_LIMIT);
  if (joins.length === 0) {
    return `Канал ${chatId}: вступлений пока нет.`;
  }

  return fitMessage(
    [`Канал ${chatId}, последние вступления по московскому времени.`, OUTCOME_LEGEND, ""],
    joins.map(
      (join) =>
        `${OUTCOME_MARKS[join.outcome]} ${formatMoscowTime(new Date(join.joinedAt * 1000))} ` +
        formatSubscriber(join),
    ),
  );
}

// Reads a user ID, or a username that the bot saw in a channel or the chat.
async function resolveTarget(
  argument: string,
  command: string,
  deps: OperatorDeps,
): Promise<Target> {
  const value = argument.trim();
  if (/^\d+$/u.test(value)) {
    return { userId: value };
  }

  const username = /^@?([A-Za-z]\w{3,31})$/u.exec(value)?.[1];
  if (!username) {
    return { error: `Укажи ID пользователя или ник: /${command} 123456 или /${command} @nick.` };
  }

  const userId = await deps.repository.findUserIdByUsername(username);
  return userId
    ? { userId }
    : { error: `Бот не видел @${username}. Ник работает только для тех, кого бот видел. Укажи ID.` };
}

async function subscriberText(userId: string, deps: OperatorDeps): Promise<string> {
  const { user, exemptSince, joins } = await deps.repository.getChannelSubscriber(
    userId,
    CHECKED_JOIN_LIMIT,
  );
  const lines = [
    user
      ? formatSubscriber({ userId, displayName: user.displayName, username: user.username })
      : `Пользователь ${userId}`,
  ];
  if (deps.ownerUserIds.has(userId)) {
    lines.push("Владелец: бот его не банит.");
  }
  if (exemptSince !== null) {
    lines.push(`В исключениях с ${formatMoscowTime(new Date(exemptSince))} МСК: бот его не банит.`);
  }

  const [latest] = joins;
  if (!user || !latest) {
    lines.push("Бот не видел, как он вступал в каналы.");
    return lines.join("\n");
  }

  const rule = matchSubscriberRule(storedUser(user, latest.isPremium));
  lines.push(
    `Правила по последнему имени и нику: ${rule ? RULE_LABELS[rule] : "ни одно не срабатывает"}.`,
    "",
    "Вступления по московскому времени:",
  );
  for (const join of joins) {
    lines.push(
      `${OUTCOME_MARKS[join.outcome]} ${formatMoscowTime(new Date(join.joinedAt * 1000))}, ` +
        `канал ${join.chatId}${join.isPremium ? ", Premium" : ""}.`,
      describeProfile(join.profile),
    );
  }
  return lines.join("\n");
}

// The rules read Telegram users, so the stored names become one.
function storedUser(user: TelegramUserProfile, isPremium: boolean): User {
  return {
    id: Number(user.id),
    is_bot: user.isBot,
    first_name: user.firstName ?? "",
    ...(user.lastName === null ? {} : { last_name: user.lastName }),
    ...(user.username === null ? {} : { username: user.username }),
    ...(isPremium ? { is_premium: true } : {}),
  };
}

function describeProfile(profile: ChannelJoinProfile | null): string {
  if (!profile) {
    return "Профиль бот не читал.";
  }

  const flags: Array<[string, boolean]> = [
    ["аватарка", profile.hasPhoto],
    ["описание", profile.hasBio],
    ["канал", profile.hasPersonalChat],
    ["эмодзи-статус", profile.hasEmojiStatus],
    ["музыка", profile.hasProfileAudio],
  ];
  const summary = flags.map(([label, present]) => `${label} ${present ? "есть" : "нет"}`).join(", ");
  return `Профиль: ${summary}${isFarmProfile(profile) ? " — как у фермы" : ""}.`;
}

async function unban(userId: string, api: Api, deps: OperatorDeps): Promise<string> {
  // The exemption comes first, so a pending ban or a new join cannot ban the user again.
  await deps.repository.exemptFromChannelBans(userId);

  const rejections: string[] = [];
  for (const chatId of deps.channelIds) {
    try {
      await api.unbanChatMember(chatId, Number(userId), { only_if_banned: true });
    } catch (error) {
      if (!(error instanceof GrammyError)) {
        throw error;
      }
      rejections.push(`канал ${chatId}: ${error.description}`);
      continue;
    }
    await deps.repository.markChannelSubscriberUnbanned(String(chatId), userId);
  }

  const exempted = `${userId} в исключениях: бот не забанит его при новой подписке.`;
  return rejections.length === 0
    ? `Разбанил. ${exempted}`
    : [`${exempted} Telegram не разбанил:`, ...rejections].join("\n");
}

async function unbanRecentBans(argument: string, deps: OperatorDeps): Promise<string> {
  const value = argument.trim();
  const hours = Number(value);
  if (!/^\d+$/u.test(value) || hours < 1) {
    return "Укажи число часов: /unban_hours 24.";
  }
  if (!deps.joinQueue) {
    return "Очередь вступлений не настроена, разбанить некому.";
  }

  // Ban times use the Worker clock.
  const after = Math.floor(Date.now() / 1000) - hours * 60 * 60;
  let queued = 0;
  for (const chatId of deps.channelIds) {
    const userIds = await deps.repository.listBannedChannelSubscribers(String(chatId), after);
    await enqueueChannelUnbans(deps.joinQueue, chatId, userIds.map(Number));
    queued += userIds.length;
  }

  return queued === 0
    ? `За ${hours} ч бот никого не забанил.`
    : `Поставил в очередь разбан: ${queued}. ` +
        "Исключения не добавляю: при новой подписке правила сработают снова.";
}
