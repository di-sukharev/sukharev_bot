import { Api, GrammyError } from "grammy";
import type { ChatMemberUpdated, User } from "grammy/types";
import {
  classifySubscriber,
  isFarmProfile,
  readSubscriberProfile,
} from "./channel-join-rules";
import { createD1ChannelJoinRepository } from "./repository";
import {
  type ChannelJoinEntry,
  type ChannelJoinInput,
  type ChannelJoinOutcome,
  type ChannelJoinProfile,
  type ChannelJoinRepository,
  type ChannelJoinWindow,
  telegramChatToProfile,
  telegramUserToProfile,
  type WorkerEnv,
} from "./types";
import { parseIdSet } from "./vibe";

export type ChannelJoinJob = {
  type: "channel_join";
  updateId: number;
  chatId: number;
  chatTitle: string | null;
  // Telegram Unix time of the membership change.
  date: number;
  user: User;
};

export type ChannelProfileJob = {
  type: "channel_profile";
  updateId: number;
  userId: number;
};

export type ChannelJoinMonitorOptions = {
  apiFetch?: typeof fetch;
  profileLookupPauseMs?: number;
};

// A burst of this many joins within the window alerts the owner, at most once
// per cooldown. A burst bans nobody.
const BURST_LIMIT = 50;
const BURST_WINDOW_SECONDS = 2;
const ALERT_COOLDOWN_SECONDS = 5 * 60;
// Profile lookups only collect data. The pause leaves the Telegram rate limit to bans.
const PROFILE_LOOKUP_PAUSE_MS = 200;
// A consumer waits out a shorter Telegram rate limit, so the wait uses no
// delivery attempt. A longer one sends the message back to the queue.
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

const TELEGRAM_MESSAGE_LIMIT = 4096;
const OUTCOME_MARKS: Record<ChannelJoinOutcome, string> = {
  allowed: "•",
  checking: "⏳",
  banned: "⛔",
  ban_failed: "⚠️",
};

const MOSCOW_TIME = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type MonitorDeps = {
  repository: ChannelJoinRepository;
  api: Api;
  ownerUserIds: Set<string>;
  alertUserId: string | null;
  profileQueue: Queue<ChannelProfileJob> | undefined;
  profileLookupPauseMs: number;
};

type RecordedJoin = {
  message: Message<ChannelJoinJob>;
  job: ChannelJoinJob;
  outcome: ChannelJoinOutcome;
};

// The retry options of each message that the queue must deliver again.
type Retries = Map<Message<ChannelJoinJob>, QueueRetryOptions | undefined>;

// Runs in the webhook. The queue keeps the work off the shared webhook.
export async function enqueueChannelJoin(
  queue: Queue<ChannelJoinJob> | undefined,
  updateId: number,
  update: ChatMemberUpdated,
): Promise<void> {
  if (!isSubscription(update)) {
    return;
  }

  // A thrown error would stall the shared webhook, so a missing queue drops the join.
  if (!queue) {
    console.error("CHANNEL_JOIN_QUEUE is not configured, so a channel join is dropped", {
      chatId: update.chat.id,
      updateId,
    });
    return;
  }

  await queue.send({
    type: "channel_join",
    updateId,
    chatId: update.chat.id,
    chatTitle: telegramChatToProfile(update.chat).title,
    date: update.date,
    user: joinedUser(update),
  });
}

export function createChannelJoinMonitor(
  env: WorkerEnv,
  options: ChannelJoinMonitorOptions = {},
) {
  const deps: MonitorDeps = {
    repository: createD1ChannelJoinRepository(env.DB),
    api: new Api(env.BOT_TOKEN, { fetch: options.apiFetch ?? fetch }),
    ownerUserIds: parseIdSet(env.OWNER_USER_IDS),
    alertUserId: env.CHANNEL_ALERT_USER_ID?.trim() || null,
    profileQueue: env.CHANNEL_PROFILE_QUEUE,
    profileLookupPauseMs: options.profileLookupPauseMs ?? PROFILE_LOOKUP_PAUSE_MS,
  };

  return {
    processJoins: (messages: readonly Message<ChannelJoinJob>[]) => processJoins(messages, deps),
    processProfiles: (messages: readonly Message<ChannelProfileJob>[]) =>
      processProfiles(messages, deps),
  };
}

function isSubscription(update: ChatMemberUpdated): boolean {
  const oldStatus = update.old_chat_member.status;
  return (
    (oldStatus === "left" || oldStatus === "kicked") &&
    update.new_chat_member.status === "member"
  );
}

// On a self-join the performer is the subscriber, and it can carry more fields.
function joinedUser(update: ChatMemberUpdated): User {
  const subscriber = update.new_chat_member.user;
  return update.from.id === subscriber.id ? { ...subscriber, ...update.from } : subscriber;
}

async function processJoins(
  messages: readonly Message<ChannelJoinJob>[],
  deps: MonitorDeps,
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  // A failed write throws, so the queue delivers the whole batch again.
  const outcomes = await deps.repository.recordChannelJoins(
    messages.map(({ body }) => joinInput(body, deps)),
  );
  const joins = messages.map((message, index): RecordedJoin => ({
    message,
    job: message.body,
    outcome: outcomes[index]!,
  }));

  const retries: Retries = new Map();
  let rateLimit: QueueRetryOptions | null = null;
  for (const join of joins) {
    if (join.outcome !== "checking" && join.outcome !== "ban_failed") {
      continue;
    }

    // Only a rate limit above the wait limit gets here. Further Telegram calls
    // fail too until it passes.
    if (rateLimit) {
      retries.set(join.message, rateLimit);
      continue;
    }

    try {
      await settleJoin(join, deps);
    } catch (error) {
      console.error("A channel join action failed and goes back to the queue", {
        updateId: join.job.updateId,
        error,
      });
      retries.set(join.message, retryOptions(error));
      rateLimit = isRateLimit(error) ? (retryOptions(error) ?? {}) : null;
    }
  }

  for (const chatJoins of Map.groupBy(joins, (join) => join.job.chatId).values()) {
    await alertBurst(chatJoins, deps, retries);
  }

  await enqueueProfileLookups(
    joins.filter((join) => join.outcome !== "checking" && !retries.has(join.message)),
    deps,
    retries,
  );

  for (const { message } of joins) {
    if (retries.has(message)) {
      message.retry(retries.get(message));
    } else {
      message.ack();
    }
  }
}

function joinInput(job: ChannelJoinJob, deps: MonitorDeps): ChannelJoinInput {
  return {
    updateId: job.updateId,
    chatId: String(job.chatId),
    user: telegramUserToProfile(job.user),
    isPremium: job.user.is_premium === true,
    languageCode: job.user.language_code ?? null,
    joinedAt: job.date,
    outcome: initialOutcome(job.user, deps),
  };
}

// A due ban stays ban_failed until Telegram confirms it.
function initialOutcome(user: User, deps: MonitorDeps): ChannelJoinInput["outcome"] {
  if (deps.ownerUserIds.has(String(user.id))) {
    return "allowed";
  }

  const verdict = classifySubscriber(user);
  return verdict === "ban" ? "ban_failed" : verdict === "check" ? "checking" : "allowed";
}

// Starts from the stored outcome, so a redelivered join resumes where it stopped.
async function settleJoin(join: RecordedJoin, deps: MonitorDeps): Promise<void> {
  const { job } = join;
  if (join.outcome === "checking") {
    const profile = await lookUpProfile(job.user.id, deps);
    if (profile) {
      await deps.repository.saveChannelJoinProfile(job.updateId, profile);
    }
    if (!profile || !isFarmProfile(profile)) {
      await deps.repository.setChannelJoinOutcome(job.updateId, "allowed");
      return;
    }
    await deps.repository.setChannelJoinOutcome(job.updateId, "ban_failed");
  }

  try {
    await callTelegram(() => deps.api.banChatMember(job.chatId, job.user.id));
  } catch (error) {
    // A rejected ban stays ban_failed. Other errors retry the join.
    if (isRejection(error)) {
      console.error("Telegram rejected a channel subscriber ban", {
        chatId: job.chatId,
        userId: job.user.id,
        error: error.description,
      });
      return;
    }

    throw error;
  }

  await deps.repository.setChannelJoinOutcome(job.updateId, "banned");
}

async function lookUpProfile(
  userId: number,
  deps: MonitorDeps,
): Promise<ChannelJoinProfile | null> {
  try {
    return readSubscriberProfile(await callTelegram(() => deps.api.getChat(userId)));
  } catch (error) {
    if (isRejection(error)) {
      console.error("Telegram rejected a subscriber profile lookup", {
        userId,
        error: error.description,
      });
      return null;
    }

    throw error;
  }
}

async function alertBurst(
  chatJoins: readonly RecordedJoin[],
  deps: MonitorDeps,
  retries: Retries,
): Promise<void> {
  const { chatId, chatTitle } = chatJoins[0]!.job;
  // A join falls into the windows that end at its second and at the next one.
  // Both checks keep detection independent of the order in which joins arrive.
  const windowEnds = [...new Set(chatJoins.flatMap(({ job }) => [job.date, job.date + 1]))];
  const activity = await deps.repository.getChannelJoinActivity(
    String(chatId),
    windowEnds.map(burstWindow),
    BURST_LIMIT,
  );
  const burstAt = Math.max(
    ...windowEnds.filter((_, index) => activity.joins[index]! >= BURST_LIMIT),
  );
  const cooledDown =
    activity.lastAlertAt === null || burstAt - activity.lastAlertAt >= ALERT_COOLDOWN_SECONDS;
  if (burstAt === -Infinity || !cooledDown) {
    return;
  }

  const window = burstWindow(burstAt);
  const joins = await deps.repository.listChannelJoins(String(chatId), window);
  try {
    await sendBurstAlert(chatTitle ?? String(chatId), burstAt, joins, deps);
  } catch (error) {
    // The joins of the burst window come back and alert again.
    console.error("A channel burst alert failed and goes back to the queue", { chatId, error });
    const windowJoins = chatJoins.filter(
      ({ job }) => job.date > window.after && job.date <= window.until,
    );
    for (const join of windowJoins) {
      retries.set(join.message, retries.get(join.message) ?? retryOptions(error));
    }
    return;
  }

  await deps.repository.markChannelAlerted(String(chatId), burstAt);
}

function burstWindow(date: number): ChannelJoinWindow {
  return { after: date - BURST_WINDOW_SECONDS, until: date };
}

async function sendBurstAlert(
  channel: string,
  burstAt: number,
  joins: readonly ChannelJoinEntry[],
  deps: MonitorDeps,
): Promise<void> {
  if (!deps.alertUserId) {
    return;
  }

  try {
    const text = buildBurstAlert(channel, burstAt, joins);
    await callTelegram(() => deps.api.sendMessage(Number(deps.alertUserId), text));
  } catch (error) {
    // A rejected alert still starts the cooldown. Other errors retry.
    if (isRejection(error)) {
      console.error("Telegram rejected a channel burst alert", {
        recipientId: deps.alertUserId,
        error: error.description,
      });
      return;
    }

    throw error;
  }
}

async function enqueueProfileLookups(
  joins: readonly RecordedJoin[],
  deps: MonitorDeps,
  retries: Retries,
): Promise<void> {
  if (joins.length === 0) {
    return;
  }

  if (!deps.profileQueue) {
    console.error("CHANNEL_PROFILE_QUEUE is not configured, so profiles are not stored");
    return;
  }

  try {
    await deps.profileQueue.sendBatch(
      joins.map(({ job }) => ({
        body: { type: "channel_profile", updateId: job.updateId, userId: job.user.id },
      })),
    );
  } catch (error) {
    // The joins come back and queue their profile lookups again. Their stored
    // outcomes keep the redelivery from repeating a confirmed ban.
    console.error("Failed to queue subscriber profile lookups, so the joins go back to the queue", {
      error,
    });
    for (const { message } of joins) {
      retries.set(message, undefined);
    }
  }
}

async function processProfiles(
  messages: readonly Message<ChannelProfileJob>[],
  deps: MonitorDeps,
): Promise<void> {
  let rateLimit: QueueRetryOptions | null = null;
  for (const [index, message] of messages.entries()) {
    // Only a rate limit above the wait limit gets here. Further Telegram calls
    // fail too until it passes.
    if (rateLimit) {
      message.retry(rateLimit);
      continue;
    }

    if (index > 0 && deps.profileLookupPauseMs > 0) {
      await sleep(deps.profileLookupPauseMs);
    }

    try {
      const profile = await lookUpProfile(message.body.userId, deps);
      if (profile) {
        await deps.repository.saveChannelJoinProfile(message.body.updateId, profile);
      }
      message.ack();
    } catch (error) {
      console.error("A subscriber profile lookup failed and goes back to the queue", {
        updateId: message.body.updateId,
        error,
      });
      message.retry(retryOptions(error));
      rateLimit = isRateLimit(error) ? (retryOptions(error) ?? {}) : null;
    }
  }
}

// Repeats the call after each rate limit up to the wait limit. A longer or
// unknown rate limit throws to the caller.
async function callTelegram<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (error) {
      const retryAfter = isRateLimit(error) ? error.parameters.retry_after : undefined;
      if (retryAfter === undefined || retryAfter > MAX_RATE_LIMIT_WAIT_SECONDS) {
        throw error;
      }

      console.warn("Telegram rate limit, the channel consumer waits", { retryAfter });
      await sleep(retryAfter * 1000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRejection(error: unknown): error is GrammyError {
  return (
    error instanceof GrammyError &&
    (error.error_code === 400 || error.error_code === 403)
  );
}

function isRateLimit(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 429;
}

function retryOptions(error: unknown): QueueRetryOptions | undefined {
  const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
  return retryAfter === undefined ? undefined : { delaySeconds: retryAfter };
}

function buildBurstAlert(
  channel: string,
  burstAt: number,
  joins: readonly ChannelJoinEntry[],
): string {
  const header = [
    "ОЙОЙ АЛЕРТ",
    `Канал «${channel}», ${MOSCOW_TIME.format(new Date(burstAt * 1000))} МСК.`,
    `DDoS: ${BURST_LIMIT} или больше вступлений за ${BURST_WINDOW_SECONDS} секунды.`,
    "В списке — подписчики, которых бот записал к моменту алерта.",
    "Бот банит только профили ботов. ⛔ — забанен, ⚠️ — бан не прошёл, ⏳ — проверяется.",
    "",
  ];
  const lines = joins.map(
    (join) =>
      `${OUTCOME_MARKS[join.outcome]} ${join.displayName}` +
      `${join.username ? ` @${join.username}` : ""} · ${join.userId}`,
  );
  return fitMessage(header, lines);
}

// Keeps the lines that fit into one message and counts the rest.
function fitMessage(header: string[], lines: string[]): string {
  const text = [...header, ...lines].join("\n");
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return text;
  }

  const overflowRoom = `\n… и ещё ${lines.length}.`.length;
  let length = header.join("\n").length;
  let shown = 0;
  while (length + 1 + lines[shown]!.length + overflowRoom <= TELEGRAM_MESSAGE_LIMIT) {
    length += 1 + lines[shown]!.length;
    shown += 1;
  }

  return [...header, ...lines.slice(0, shown), `… и ещё ${lines.length - shown}.`].join("\n");
}
