import { Bot, Context } from "grammy";
import type { Chat, Message, Update, User, UserFromGetMe } from "grammy/types";
import { createD1CommunityBotRepository } from "./repository";
import type {
  CommunityBotRepository,
  ReactionVibeState,
  RuntimeConfig,
  TelegramUserProfile,
  WorkerEnv,
} from "./types";
import {
  telegramChatToProfile,
  telegramUserToProfile,
} from "./types";
import {
  buildAwardMessage,
  buildProfanityModerationMessage,
  buildRulesMessage,
  buildWelcomeMessage,
  containsProfanity,
  countNegativeReactionTotal,
  countNegativeReactions,
  countPositiveReactionTotal,
  countPositiveReactions,
  formatVibeScore,
  formatVibeScoreParenthetical,
  hasDisallowedTelegramLink,
  isChatAllowed,
  isThanksMessage,
  LINK_MODERATION_MESSAGE,
  MAIN_CHANNEL_USERNAME,
  normalizeTelegramUsername,
  parseBoolean,
  parseIdSet,
  parseUsernameSet,
  PROFANITY_WORDS,
} from "./vibe";
import {
  scheduleVibeNotificationDelete,
  type VibeNotificationDeleteOptions,
  WELCOME_MESSAGE_DELETE_DELAY_SECONDS,
} from "./vibe-notification-delete";

export type CommunityBotContext = Context & {
  config: RuntimeConfig;
  notificationDelete: VibeNotificationDeleteOptions;
  repository: CommunityBotRepository;
};

export type CommunityBotOptions = {
  repository?: CommunityBotRepository;
  apiFetch?: typeof fetch;
  notificationDelete?: VibeNotificationDeleteOptions;
  profanityWords?: readonly string[];
};

const VIBE_TOP_LIMIT = 10;
const LINK_PERMISSION_VIBE_THRESHOLD = 25;
const AGGREGATE_REACTION_ACTOR_ID = "__reaction_count__";
const UNKNOWN_MESSAGE_AUTHOR_ID = "__unknown_message_author__";
const NEGATIVE_DELETE_MESSAGE_THRESHOLD = 3;
const LOW_VIBE_WARNING_THRESHOLD = -5;
const LOW_VIBE_BAN_THRESHOLD = -10;

type MessageReactionUpdate = NonNullable<Update["message_reaction"]> & {
  actor_chat?: Chat;
};

export function createCommunityBot(
  env: WorkerEnv,
  options: CommunityBotOptions = {},
): Bot<CommunityBotContext> {
  const botInfo = parseBotInfo(env.BOT_INFO);
  const bot = new Bot<CommunityBotContext>(env.BOT_TOKEN, {
    botInfo,
    client: options.apiFetch ? { fetch: options.apiFetch } : undefined,
  });
  const repository = options.repository ?? createD1CommunityBotRepository(env.DB);
  const config = createRuntimeConfig(
    env,
    botInfo,
    options.profanityWords ?? PROFANITY_WORDS,
  );
  const notificationDelete: VibeNotificationDeleteOptions = {
    apiFetch: options.notificationDelete?.apiFetch ?? options.apiFetch,
    delayMs: options.notificationDelete?.delayMs,
    delaySeconds: options.notificationDelete?.delaySeconds,
    scheduleTask: options.notificationDelete?.scheduleTask,
  };

  bot.use(async (ctx, next) => {
    ctx.repository = repository;
    ctx.config = config;
    ctx.notificationDelete = notificationDelete;

    const reservation = await repository.reserveUpdateProcessing(ctx.update.update_id);
    if (reservation.status === "processed") {
      return;
    }
    if (reservation.status === "processing") {
      throw new Error("Update processing is already reserved");
    }

    try {
      await next();
    } catch (error) {
      await repository.releaseUpdateReservation(reservation);
      throw error;
    }

    await repository.markUpdateProcessed(reservation);
  });

  bot.use(async (ctx, next) => {
    const chat = getUpdateChat(ctx.update);
    if (!chat) {
      await next();
      return;
    }

    const chatId = String(chat.id);
    const canBypassAllowList = isChatIdCommand(ctx.update, config.botUsername);
    if (!canBypassAllowList && !isChatAllowed(chatId, config.allowedChatIds)) {
      return;
    }

    await repository.upsertChat(telegramChatToProfile(chat));
    await next();
  });

  bot.use(async (ctx, next) => {
    const message = await getDisallowedLinkMessage(ctx);
    if (!message) {
      await next();
      return;
    }

    await deleteDisallowedLinkMessage(ctx, message);
  });

  bot.use(async (ctx, next) => {
    const message = getProfanityModeratedMessage(ctx.update, ctx.config);
    if (!message) {
      await next();
      return;
    }

    await deleteProfanityMessage(ctx, message);
  });

  bot.command("chatid", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await ctx.reply("Не вижу chat id в этом update.");
      return;
    }

    await ctx.reply(`chat id: ${chatId}`);
  });

  bot.command("vibe", async (ctx) => {
    if (!ctx.chat || !ctx.from || ctx.from.is_bot) {
      return;
    }

    const user = telegramUserToProfile(ctx.from);
    await ctx.repository.upsertUser(user);

    const score = await ctx.repository.getVibeScore(String(ctx.chat.id), user.id);
    await ctx.reply(`${user.displayName}, у вас ${formatVibeScore(score)}.`);
  });

  bot.command("vibe_top", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const top = await ctx.repository.getVibeTop(String(ctx.chat.id), VIBE_TOP_LIMIT);
    if (top.length === 0) {
      await ctx.reply("Пока вайба нет. Вайбуйте");
      return;
    }

    await ctx.reply(
      top
        .map((entry, index) => {
          return `${index + 1}. ${entry.displayName} — ${formatVibeScore(entry.score)}`;
        })
        .join("\n"),
    );
  });

  bot.command("rules", async (ctx) => {
    const rules = buildRulesMessage();
    await ctx.reply(rules.text, {
      parse_mode: rules.parseMode,
    });
  });

  bot.on("chat_member", async (ctx) => {
    const chatMemberUpdate = ctx.update.chat_member;
    const newMember = chatMemberUpdate.new_chat_member;
    const oldMember = chatMemberUpdate.old_chat_member;
    const user = newMember.user;

    if (user.is_bot || !isJoinTransition(oldMember.status, newMember.status, newMember)) {
      return;
    }

    const profile = telegramUserToProfile(user);
    await ctx.repository.upsertUser(profile);
    if (isWelcomeMuted(ctx.config)) {
      return;
    }

    const welcome = buildWelcomeMessage(profile.displayName);
    const sentMessage = await ctx.api.sendMessage(
      chatMemberUpdate.chat.id,
      welcome.text,
      {
        parse_mode: welcome.parseMode,
      },
    );
    await scheduleVibeNotificationDelete(
      env,
      {
        chatId: chatMemberUpdate.chat.id,
        messageId: sentMessage.message_id,
      },
      {
        ...ctx.notificationDelete,
        delaySeconds: WELCOME_MESSAGE_DELETE_DELAY_SECONDS,
      },
    );
  });

  bot.on("message_reaction", async (ctx) => {
    const reactionUpdate = ctx.update.message_reaction as MessageReactionUpdate;
    const actorUser = reactionUpdate.user;
    const actorId = getReactionActorId(reactionUpdate);
    if (!actorId) {
      return;
    }

    const chatId = String(reactionUpdate.chat.id);
    const recipient = await ctx.repository.findMessageAuthor(
      chatId,
      reactionUpdate.message_id,
    );
    const vibeRecipient = recipient && !recipient.isBot ? recipient : null;

    const reactionReservation = await ctx.repository.reserveReactionProcessing(
      chatId,
      reactionUpdate.message_id,
      actorId,
    );
    if (!reactionReservation) {
      throw new Error("Reaction award processing is already reserved");
    }

    try {
      const previousState = await ctx.repository.getReactionVibeState(
        chatId,
        reactionUpdate.message_id,
        actorId,
      );
      if (isStaleReactionUpdate(previousState, reactionUpdate.date, ctx.update.update_id)) {
        return;
      }

      if (recipient?.id === actorId) {
        await ctx.repository.setReactionVibeState({
          chatId,
          messageId: reactionUpdate.message_id,
          actorId,
          recipientUserId: recipient.id,
          positiveReactionCount: 0,
          negativeReactionCount: 0,
          chargedNegativeReactionCount: 0,
          lastUpdateDate: reactionUpdate.date,
          lastUpdateId: ctx.update.update_id,
        });
        return;
      }

      const nextState = {
        positiveReactionCount: countPositiveReactions(reactionUpdate.new_reaction),
        negativeReactionCount: countNegativeReactions(reactionUpdate.new_reaction),
      };
      const deltas = getReactionStateDeltas(previousState, nextState);
      let vibeDelta = getRecipientVibeDelta(
        previousState,
        nextState,
        vibeRecipient?.id ?? null,
        deltas,
      );

      if (actorUser && hasReactionStateChange(deltas)) {
        await ctx.repository.upsertUser(telegramUserToProfile(actorUser));
      }

      const state = {
        chatId,
        messageId: reactionUpdate.message_id,
        actorId,
        recipientUserId: recipient?.id ?? UNKNOWN_MESSAGE_AUTHOR_ID,
        ...nextState,
        chargedNegativeReactionCount: 0,
        lastUpdateDate: reactionUpdate.date,
        lastUpdateId: ctx.update.update_id,
      };
      let inserted = false;
      let allowNegativeAnnouncement = true;
      if (
        vibeRecipient &&
        (nextState.negativeReactionCount > 0 || previousState.negativeReactionCount > 0)
      ) {
        const sameRecipient = previousState.recipientUserId === null ||
          previousState.recipientUserId === vibeRecipient.id;
        const previousCharged = sameRecipient ? previousState.chargedNegativeReactionCount : 0;
        const retainedCharges = Math.min(previousCharged, nextState.negativeReactionCount);
        const result = await ctx.repository.applyLimitedReactionVibe({
          entry: {
            idempotencyKey: `reaction:${ctx.update.update_id}`,
            chatId,
            recipientUserId: vibeRecipient.id,
            actorUserId: actorId,
            delta: nextState.positiveReactionCount -
              (sameRecipient ? previousState.positiveReactionCount : 0) +
              previousCharged - retainedCharges,
            source: "message_reaction",
            reason: "reaction vibe delta",
            sourceMessageId: null,
            targetMessageId: reactionUpdate.message_id,
          },
          state: { ...state, chargedNegativeReactionCount: retainedCharges },
          requestNegativeCharge: nextState.negativeReactionCount >
            (sameRecipient ? previousState.negativeReactionCount : 0),
        });
        vibeDelta = result.delta;
        inserted = result.inserted && vibeDelta !== 0;
        allowNegativeAnnouncement = result.negativeChargeApplied;
      } else {
        inserted = vibeDelta === 0 || !vibeRecipient
          ? false
          : await ctx.repository.addVibeLedgerEntry({
              idempotencyKey: `reaction:${ctx.update.update_id}`,
              chatId,
              recipientUserId: vibeRecipient.id,
              actorUserId: actorId,
              delta: vibeDelta,
              source: "message_reaction",
              reason: "reaction vibe delta",
              sourceMessageId: null,
              targetMessageId: reactionUpdate.message_id,
            });
        await ctx.repository.setReactionVibeState(state);
      }

      const currentScore = inserted && vibeRecipient
        ? await ctx.repository.getVibeScore(chatId, vibeRecipient.id)
        : null;

      if (
        inserted &&
        vibeRecipient &&
        (vibeDelta > 0 || allowNegativeAnnouncement) &&
        shouldAnnounceReactionDelta(ctx.config, deltas, vibeDelta)
      ) {
        const sentMessage = await ctx.api.sendMessage(
          reactionUpdate.chat.id,
          buildReactionVibeMessage(ctx, vibeDelta, vibeRecipient, currentScore),
          replyToMessage(reactionUpdate.message_id),
        );
        if (vibeDelta > 0) {
          await scheduleVibeNotificationDelete(
            env,
            {
              chatId: reactionUpdate.chat.id,
              messageId: sentMessage.message_id,
            },
            ctx.notificationDelete,
          );
        }
      }

      if (nextState.negativeReactionCount > 0) {
        await maybeDeleteNegativeModeratedMessage(
          ctx,
          reactionUpdate.chat.id,
          chatId,
          reactionUpdate.message_id,
          recipient,
        );
      }
      if (vibeRecipient) {
        await maybeBanForLowVibe(
          ctx,
          reactionUpdate.chat.id,
          chatId,
          vibeRecipient,
          currentScore,
        );
      }
    } finally {
      await ctx.repository.releaseReactionProcessing(reactionReservation);
    }
  });

  bot.on("message_reaction_count", async (ctx) => {
    const reactionUpdate = ctx.update.message_reaction_count;
    const chatId = String(reactionUpdate.chat.id);
    const recipient = await ctx.repository.findMessageAuthor(
      chatId,
      reactionUpdate.message_id,
    );
    const vibeRecipient = recipient && !recipient.isBot ? recipient : null;

    const reactionReservation = await ctx.repository.reserveReactionProcessing(
      chatId,
      reactionUpdate.message_id,
      AGGREGATE_REACTION_ACTOR_ID,
    );
    if (!reactionReservation) {
      throw new Error("Aggregate reaction award processing is already reserved");
    }

    try {
      const previousState = await ctx.repository.getReactionVibeState(
        chatId,
        reactionUpdate.message_id,
        AGGREGATE_REACTION_ACTOR_ID,
      );
      if (isStaleReactionUpdate(previousState, reactionUpdate.date, ctx.update.update_id)) {
        return;
      }

      const nextState = {
        positiveReactionCount: countPositiveReactionTotal(reactionUpdate.reactions),
        negativeReactionCount: countNegativeReactionTotal(reactionUpdate.reactions),
      };
      const deltas = getReactionStateDeltas(previousState, nextState);
      const vibeDelta = getRecipientVibeDelta(
        previousState,
        nextState,
        vibeRecipient?.id ?? null,
        deltas,
      );

      const inserted = vibeDelta === 0 || !vibeRecipient
        ? false
        : await ctx.repository.addVibeLedgerEntry({
            idempotencyKey: `reaction_count:${ctx.update.update_id}`,
            chatId,
            recipientUserId: vibeRecipient.id,
            actorUserId: null,
            delta: vibeDelta,
            source: "message_reaction",
            reason: "reaction count vibe delta",
            sourceMessageId: null,
            targetMessageId: reactionUpdate.message_id,
          });

      await ctx.repository.setReactionVibeState({
        chatId,
        messageId: reactionUpdate.message_id,
        actorId: AGGREGATE_REACTION_ACTOR_ID,
        recipientUserId: recipient?.id ?? UNKNOWN_MESSAGE_AUTHOR_ID,
        ...nextState,
        chargedNegativeReactionCount: 0,
        lastUpdateDate: reactionUpdate.date,
        lastUpdateId: ctx.update.update_id,
      });

      const currentScore = inserted && vibeRecipient
        ? await ctx.repository.getVibeScore(chatId, vibeRecipient.id)
        : null;

      if (
        inserted &&
        vibeRecipient &&
        shouldAnnounceReactionDelta(ctx.config, deltas, vibeDelta)
      ) {
        const sentMessage = await ctx.api.sendMessage(
          reactionUpdate.chat.id,
          buildReactionVibeMessage(ctx, vibeDelta, vibeRecipient, currentScore),
          replyToMessage(reactionUpdate.message_id),
        );
        if (vibeDelta > 0) {
          await scheduleVibeNotificationDelete(
            env,
            {
              chatId: reactionUpdate.chat.id,
              messageId: sentMessage.message_id,
            },
            ctx.notificationDelete,
          );
        }
      }

      if (nextState.negativeReactionCount > 0) {
        await maybeDeleteNegativeModeratedMessage(
          ctx,
          reactionUpdate.chat.id,
          chatId,
          reactionUpdate.message_id,
          recipient,
        );
      }
      if (vibeRecipient) {
        await maybeBanForLowVibe(
          ctx,
          reactionUpdate.chat.id,
          chatId,
          vibeRecipient,
          currentScore,
        );
      }
    } finally {
      await ctx.repository.releaseReactionProcessing(reactionReservation);
    }
  });

  bot.on("message", async (ctx) => {
    const message = ctx.message;
    await storeReactionModeratedMessage(ctx, message);

    await maybeAwardThanksReply(ctx, message, env);
  });

  bot.on("edited_message", async (ctx) => {
    await storeReactionModeratedMessage(ctx, ctx.editedMessage);
  });

  bot.on("channel_post", async (ctx) => {
    await storeReactionModeratedMessage(ctx, ctx.channelPost);
  });

  bot.on("edited_channel_post", async (ctx) => {
    await storeReactionModeratedMessage(ctx, ctx.editedChannelPost);
  });

  return bot;
}

export function createRuntimeConfig(
  env: WorkerEnv,
  botInfo: UserFromGetMe,
  profanityWords: readonly string[] = PROFANITY_WORDS,
): RuntimeConfig {
  return {
    allowedChatIds: parseIdSet(env.ALLOWED_CHAT_IDS),
    ownerUserIds: parseIdSet(env.OWNER_USER_IDS),
    announceReactions: parseBoolean(env.ANNOUNCE_REACTIONS),
    welcomeMutedUntilMs: parseOptionalTimestampMs(env.WELCOME_MUTED_UNTIL),
    linkAllowedUsernames: parseUsernameSet(env.LINK_ALLOWED_USERNAMES),
    botUsername: botInfo.username?.toLowerCase() ?? null,
    profanityWords,
  };
}

function isWelcomeMuted(config: RuntimeConfig): boolean {
  return config.welcomeMutedUntilMs !== null && Date.now() < config.welcomeMutedUntilMs;
}

function parseOptionalTimestampMs(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const timestampMs = Date.parse(trimmed);
  if (Number.isNaN(timestampMs)) {
    throw new Error("WELCOME_MUTED_UNTIL must be an ISO timestamp");
  }

  return timestampMs;
}

type ReactionStateDeltas = {
  positiveDelta: number;
  negativeDelta: number;
  vibeDelta: number;
};

type ReactionCounts = Pick<
  ReactionVibeState,
  "positiveReactionCount" | "negativeReactionCount"
>;

function getReactionStateDeltas(
  previousState: ReactionCounts,
  nextState: ReactionCounts,
): ReactionStateDeltas {
  const positiveDelta =
    nextState.positiveReactionCount - previousState.positiveReactionCount;
  const negativeDelta =
    nextState.negativeReactionCount - previousState.negativeReactionCount;
  return {
    positiveDelta,
    negativeDelta,
    vibeDelta: positiveDelta - negativeDelta,
  };
}

function getRecipientVibeDelta(
  previousState: ReactionVibeState,
  nextState: ReactionCounts,
  recipientUserId: string | null,
  deltas: ReactionStateDeltas,
): number {
  if (!recipientUserId) {
    return 0;
  }

  if (
    previousState.recipientUserId === null ||
    previousState.recipientUserId === recipientUserId
  ) {
    return deltas.vibeDelta;
  }

  // Reactions observed before an eligible author was known were never written
  // to the vibe ledger. Rebase the new author's state from an unawarded zero
  // baseline so later removals cannot create unearned vibe.
  return nextState.positiveReactionCount - nextState.negativeReactionCount;
}

function hasReactionStateChange(deltas: ReactionStateDeltas): boolean {
  return deltas.positiveDelta !== 0 || deltas.negativeDelta !== 0;
}

function isStaleReactionUpdate(
  previousState: ReactionVibeState,
  updateDate: number,
  updateId: number,
): boolean {
  if (previousState.lastUpdateDate !== null) {
    if (updateDate !== previousState.lastUpdateDate) {
      return updateDate < previousState.lastUpdateDate;
    }

    return previousState.lastUpdateId !== null && updateId < previousState.lastUpdateId;
  }

  return previousState.lastUpdateId !== null && updateId < previousState.lastUpdateId;
}

function shouldAnnounceReactionDelta(
  config: RuntimeConfig,
  deltas: ReactionStateDeltas,
  vibeDelta: number,
): boolean {
  return (
    config.announceReactions &&
    vibeDelta !== 0 &&
    (deltas.positiveDelta > 0 || deltas.negativeDelta > 0)
  );
}

async function maybeDeleteNegativeModeratedMessage(
  ctx: CommunityBotContext,
  apiChatId: number | string,
  chatId: string,
  messageId: number,
  recipient: TelegramUserProfile | null,
): Promise<void> {
  if (recipient && ctx.config.ownerUserIds.has(recipient.id)) {
    return;
  }

  const messageNegativeReactionCount =
    await ctx.repository.getMessageNegativeReactionCount(
      chatId,
      messageId,
      recipient?.id ?? null,
    );
  if (messageNegativeReactionCount >= NEGATIVE_DELETE_MESSAGE_THRESHOLD) {
    await runModerationAction(
      ctx,
      {
        idempotencyKey: `delete_message:${chatId}:${messageId}`,
        chatId,
        action: "delete_message",
        targetUserId: recipient?.id ?? null,
        targetMessageId: messageId,
      },
      async () => {
        await deleteModeratedMessage(ctx, apiChatId, messageId);
      },
    );
  }
}

async function maybeBanForLowVibe(
  ctx: CommunityBotContext,
  apiChatId: number | string,
  chatId: string,
  recipient: TelegramUserProfile,
  knownScore: number | null = null,
): Promise<void> {
  if (
    recipient.isBot ||
    ctx.config.ownerUserIds.has(recipient.id) ||
    normalizeTelegramUsername(recipient.username) === "haltmachina"
  ) {
    return;
  }

  const score = knownScore ?? await ctx.repository.getVibeScore(chatId, recipient.id);
  if (score <= LOW_VIBE_BAN_THRESHOLD) {
    const member = await ctx.api.getChatMember(apiChatId, Number(recipient.id));
    const isParticipant = member.status === "member" ||
      (member.status === "restricted" && member.is_member);
    if (
      !isParticipant ||
      normalizeTelegramUsername(member.user.username) === "haltmachina"
    ) {
      return;
    }

    await runModerationAction(
      ctx,
      {
        idempotencyKey: `ban_user:${chatId}:${recipient.id}`,
        chatId,
        action: "ban_user",
        targetUserId: recipient.id,
        targetMessageId: null,
      },
      async () => {
        await ctx.api.banChatMember(apiChatId, Number(recipient.id), {
          revoke_messages: true,
        });
      },
    );
  }
}

async function deleteProfanityMessage(
  ctx: CommunityBotContext,
  message: Message,
): Promise<void> {
  const authorUser = getModeratableUserAuthor(message);
  if (!authorUser) {
    return;
  }

  const author = telegramUserToProfile(authorUser);
  await ctx.repository.upsertUser(author);

  const chatId = String(message.chat.id);
  const inserted = await ctx.repository.addVibeLedgerEntry({
    idempotencyKey: `profanity:${ctx.update.update_id}`,
    chatId,
    recipientUserId: author.id,
    actorUserId: author.id,
    delta: -1,
    source: "profanity",
    reason: "profanity message",
    sourceMessageId: message.message_id,
    targetMessageId: message.message_id,
  });

  const currentScore = inserted
    ? await ctx.repository.getVibeScore(chatId, author.id)
    : null;

  await runModerationAction(
    ctx,
    {
      idempotencyKey: `delete_message:${chatId}:${message.message_id}`,
      chatId,
      action: "delete_message",
      targetUserId: author.id,
      targetMessageId: message.message_id,
    },
    async () => {
      await deleteModeratedMessage(ctx, message.chat.id, message.message_id);
    },
  );
  await sendModerationWarning(
    ctx,
    {
      idempotencyKey: `send_warning:profanity:${chatId}:${message.message_id}`,
      chatId,
      action: "send_warning",
      targetUserId: author.id,
      targetMessageId: message.message_id,
    },
    message.chat.id,
    buildProfanityModerationWarning(ctx, message, author, currentScore),
  );

  await maybeBanForLowVibe(ctx, message.chat.id, chatId, author, currentScore);
}

function buildReactionVibeMessage(
  ctx: CommunityBotContext,
  delta: number,
  recipient: TelegramUserProfile,
  currentScore: number | null,
): string {
  if (delta > 0) {
    return buildAwardMessage(delta, recipient.displayName, currentScore);
  }

  return appendLowVibeWarning(
    `${recipient.displayName}, ${formatNegativeVibeDelta(delta, currentScore)}`,
    ctx,
    recipient,
    currentScore,
    ". ",
  );
}

function buildProfanityModerationWarning(
  ctx: CommunityBotContext,
  message: Message,
  author: TelegramUserProfile,
  currentScore: number | null,
): string {
  return appendLowVibeWarning(
    buildUserAddressedModerationWarning(
      message.from,
      buildProfanityModerationMessage(currentScore),
    ),
    ctx,
    author,
    currentScore,
    " ",
  );
}

function appendLowVibeWarning(
  message: string,
  ctx: CommunityBotContext,
  recipient: TelegramUserProfile,
  currentScore: number | null,
  separator: string,
): string {
  if (
    currentScore === null ||
    currentScore > LOW_VIBE_WARNING_THRESHOLD ||
    recipient.isBot ||
    ctx.config.ownerUserIds.has(recipient.id)
  ) {
    return message;
  }

  return `${message}${separator}у вас уже ${formatVibeScore(currentScore)}, при -10 я запрограммирована кикать из чата 🥊`;
}

function formatNegativeVibeDelta(delta: number, currentScore: number | null): string {
  const amount = Math.abs(delta);
  const vibeWord = amount === 1 ? "вайб" : "вайба";
  return `минус ${amount} ${vibeWord}${formatVibeScoreParenthetical(currentScore)}`;
}

function replyToMessage(messageId: number) {
  return {
    reply_to_message_id: messageId,
    allow_sending_without_reply: true,
  };
}

function getMessageText(message: Message): string | null {
  if ("text" in message) {
    return message.text ?? null;
  }

  if ("caption" in message) {
    return message.caption ?? null;
  }

  return null;
}

async function storeReactionModeratedMessage(
  ctx: CommunityBotContext,
  message: Message,
): Promise<void> {
  const author = getReactionModeratedMessageAuthor(message);
  if (!author) {
    return;
  }

  await ctx.repository.upsertUser(author);
  await ctx.repository.storeMessage({
    chatId: String(message.chat.id),
    messageId: message.message_id,
    authorUserId: author.id,
    sentAt: message.date ?? null,
  });
}

function getReactionModeratedMessageAuthor(
  message: Message,
): TelegramUserProfile | null {
  if (message.sender_chat) {
    const senderChat = telegramChatToProfile(message.sender_chat);
    return {
      id: `chat:${senderChat.id}`,
      username: senderChat.username,
      firstName: null,
      lastName: null,
      displayName:
        senderChat.title ??
        (senderChat.username ? `@${senderChat.username}` : `chat ${senderChat.id}`),
      isBot: true,
    };
  }

  return message.from ? telegramUserToProfile(message.from) : null;
}

async function getDisallowedLinkMessage(
  ctx: CommunityBotContext,
): Promise<Message | null> {
  if (
    ctx.update.message &&
    (await shouldDeleteDisallowedLink(ctx.update.message, ctx))
  ) {
    return ctx.update.message;
  }

  if (
    ctx.update.edited_message &&
    (await shouldDeleteDisallowedLink(ctx.update.edited_message, ctx))
  ) {
    return ctx.update.edited_message;
  }

  if (
    ctx.update.channel_post &&
    (await shouldDeleteDisallowedLink(ctx.update.channel_post, ctx))
  ) {
    return ctx.update.channel_post;
  }

  if (
    ctx.update.edited_channel_post &&
    (await shouldDeleteDisallowedLink(ctx.update.edited_channel_post, ctx))
  ) {
    return ctx.update.edited_channel_post;
  }

  return null;
}

function getProfanityModeratedMessage(
  update: Update,
  config: RuntimeConfig,
): Message | null {
  if (update.message && shouldDeleteProfanityMessage(update.message, config)) {
    return update.message;
  }

  if (
    update.edited_message &&
    shouldDeleteProfanityMessage(update.edited_message, config)
  ) {
    return update.edited_message;
  }

  if (
    update.channel_post &&
    shouldDeleteProfanityMessage(update.channel_post, config)
  ) {
    return update.channel_post;
  }

  if (
    update.edited_channel_post &&
    shouldDeleteProfanityMessage(update.edited_channel_post, config)
  ) {
    return update.edited_channel_post;
  }

  return null;
}

function shouldDeleteProfanityMessage(
  message: Message,
  config: RuntimeConfig,
): boolean {
  return (
    getModeratableUserAuthor(message) !== null &&
    containsProfanity(getMessageText(message), config.profanityWords)
  );
}

function getModeratableUserAuthor(message: Message): User | null {
  if ("sender_chat" in message && message.sender_chat) {
    return null;
  }

  const user = message.from;
  if (!user || user.is_bot) {
    return null;
  }

  return user;
}

async function shouldDeleteDisallowedLink(
  message: Message,
  ctx: CommunityBotContext,
): Promise<boolean> {
  if (
    canSendDisallowedLinks(message, ctx.config) ||
    !hasDisallowedTelegramLink(message)
  ) {
    return false;
  }

  return !(await hasEnoughVibeForLinks(message, ctx));
}

function canSendDisallowedLinks(message: Message, config: RuntimeConfig): boolean {
  return (
    isAutomaticForwardFromMainChannel(message) ||
    isLinkAllowedUser(message.from, config)
  );
}

function isAutomaticForwardFromMainChannel(message: Message): boolean {
  return (
    message.is_automatic_forward === true &&
    message.sender_chat?.type === "channel" &&
    normalizeTelegramUsername(message.sender_chat.username) ===
      MAIN_CHANNEL_USERNAME
  );
}

function isLinkAllowedUser(
  user: User | undefined,
  config: RuntimeConfig,
): boolean {
  if (!user) {
    return false;
  }

  if (config.ownerUserIds.has(String(user.id))) {
    return true;
  }

  const username = normalizeTelegramUsername(user.username);
  return username !== null && config.linkAllowedUsernames.has(username);
}

async function hasEnoughVibeForLinks(
  message: Message,
  ctx: CommunityBotContext,
): Promise<boolean> {
  const user = getVibeQualifiedLinkAuthor(message);
  if (!user) {
    return false;
  }

  const score = await ctx.repository.getVibeScore(String(message.chat.id), String(user.id));
  return score >= LINK_PERMISSION_VIBE_THRESHOLD;
}

function getVibeQualifiedLinkAuthor(message: Message): User | null {
  if ("sender_chat" in message && message.sender_chat) {
    return null;
  }

  const user = message.from;
  return user && !user.is_bot ? user : null;
}

async function deleteDisallowedLinkMessage(
  ctx: CommunityBotContext,
  message: Message,
): Promise<void> {
  const chatId = String(message.chat.id);
  await runModerationAction(
    ctx,
    {
      idempotencyKey: `delete_message:${chatId}:${message.message_id}`,
      chatId,
      action: "delete_message",
      targetUserId: message.from ? String(message.from.id) : null,
      targetMessageId: message.message_id,
    },
    async () => {
      await deleteModeratedMessage(ctx, message.chat.id, message.message_id);
    },
  );
  await sendModerationWarning(
    ctx,
    {
      idempotencyKey: `send_warning:link:${chatId}:${message.message_id}`,
      chatId,
      action: "send_warning",
      targetUserId: message.from ? String(message.from.id) : null,
      targetMessageId: message.message_id,
    },
    message.chat.id,
    buildLinkModerationWarning(message),
  );
}

function buildLinkModerationWarning(message: Message): string {
  return buildUserAddressedModerationWarning(message.from, LINK_MODERATION_MESSAGE);
}

function buildUserAddressedModerationWarning(
  user: User | undefined,
  message: string,
): string {
  if (!user) {
    return message;
  }

  const username = normalizeTelegramUsername(user.username);
  if (username) {
    return `@${username}, ${message}`;
  }

  return `${telegramUserToProfile(user).displayName}, ${message}`;
}

async function runModerationAction(
  ctx: CommunityBotContext,
  input: Parameters<CommunityBotRepository["reserveModerationAction"]>[0],
  action: () => Promise<void>,
): Promise<boolean> {
  const reservation = await ctx.repository.reserveModerationAction(input);
  if (reservation.status === "completed") {
    return false;
  }
  if (reservation.status === "processing") {
    throw new Error(`Moderation action is already reserved: ${input.idempotencyKey}`);
  }

  try {
    await action();
  } catch (error) {
    await ctx.repository.releaseModerationAction(reservation);
    console.error("Telegram moderation action failed", {
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      error: getErrorMessage(error),
    });
    throw error;
  }

  await ctx.repository.completeModerationAction(reservation);
  return true;
}

async function sendModerationWarning(
  ctx: CommunityBotContext,
  input: Parameters<CommunityBotRepository["reserveModerationAction"]>[0],
  chatId: number | string,
  text: string,
): Promise<void> {
  await runModerationAction(ctx, input, async () => {
    await ctx.api.sendMessage(chatId, text);
  });
}

async function deleteModeratedMessage(
  ctx: CommunityBotContext,
  chatId: number | string,
  messageId: number,
): Promise<void> {
  try {
    await ctx.api.deleteMessage(chatId, messageId);
  } catch (error) {
    if (isTerminalDeleteError(error)) {
      return;
    }

    throw error;
  }
}

function isTerminalDeleteError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const telegramError = error as { error_code?: number; description?: string };
  if (telegramError.error_code !== 400 || !telegramError.description) {
    return false;
  }

  const description = telegramError.description.toLowerCase();
  return (
    description.includes("message to delete not found") ||
    description.includes("message can't be deleted") ||
    description.includes("message cannot be deleted")
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getReactionActorId(reactionUpdate: MessageReactionUpdate): string | null {
  if (reactionUpdate.user) {
    return reactionUpdate.user.is_bot ? null : String(reactionUpdate.user.id);
  }

  if (reactionUpdate.actor_chat) {
    return `chat:${reactionUpdate.actor_chat.id}`;
  }

  return null;
}

export function parseBotInfo(value: string | undefined): UserFromGetMe {
  if (!value) {
    throw new Error("BOT_INFO is required");
  }

  const parsed = JSON.parse(value) as Partial<UserFromGetMe>;
  if (
    typeof parsed.id !== "number" ||
    parsed.id <= 0 ||
    parsed.is_bot !== true ||
    typeof parsed.first_name !== "string"
  ) {
    throw new Error("BOT_INFO must be Telegram getMe result JSON");
  }

  return parsed as UserFromGetMe;
}

async function maybeAwardThanksReply(
  ctx: CommunityBotContext,
  message: Message,
  env: WorkerEnv,
): Promise<void> {
  if (!message.from || message.from.is_bot || !message.reply_to_message) {
    return;
  }

  const text = "text" in message ? message.text : "caption" in message ? message.caption : null;
  if (!isThanksMessage(text)) {
    return;
  }

  const actor = telegramUserToProfile(message.from);
  const recipient = await resolveReplyRecipient(ctx.repository, message);
  if (!recipient || recipient.isBot || recipient.id === actor.id) {
    return;
  }

  await ctx.repository.upsertUser(actor);
  await ctx.repository.upsertUser(recipient);

  const chatId = String(message.chat.id);
  const inserted = await ctx.repository.addVibeLedgerEntry({
    idempotencyKey: `thanks:${ctx.update.update_id}`,
    chatId,
    recipientUserId: recipient.id,
    actorUserId: actor.id,
    delta: 1,
    source: "thanks_reply",
    reason: "thanks reply",
    sourceMessageId: message.message_id,
    targetMessageId: message.reply_to_message.message_id,
  });

  if (inserted) {
    const currentScore = await ctx.repository.getVibeScore(chatId, recipient.id);
    const sentMessage = await ctx.reply(
      buildAwardMessage(1, recipient.displayName, currentScore),
      replyToMessage(message.reply_to_message.message_id),
    );
    await scheduleVibeNotificationDelete(
      env,
      {
        chatId: message.chat.id,
        messageId: sentMessage.message_id,
      },
      ctx.notificationDelete,
    );
  }
}

async function resolveReplyRecipient(
  repository: CommunityBotRepository,
  message: Message,
): Promise<TelegramUserProfile | null> {
  const reply = message.reply_to_message;
  if (!reply) {
    return null;
  }

  if (reply.from && !reply.sender_chat) {
    return telegramUserToProfile(reply.from);
  }

  return repository.findMessageAuthor(String(message.chat.id), reply.message_id);
}

function getUpdateChat(update: Update): Chat | null {
  if (update.message) {
    return update.message.chat;
  }

  if (update.edited_message) {
    return update.edited_message.chat;
  }

  if (update.channel_post) {
    return update.channel_post.chat;
  }

  if (update.edited_channel_post) {
    return update.edited_channel_post.chat;
  }

  if (update.chat_member) {
    return update.chat_member.chat;
  }

  if (update.message_reaction) {
    return update.message_reaction.chat;
  }

  if (update.message_reaction_count) {
    return update.message_reaction_count.chat;
  }

  return null;
}

function isChatIdCommand(update: Update, botUsername: string | null): boolean {
  const text = update.message && "text" in update.message ? update.message.text : null;
  if (!text) {
    return false;
  }

  const [command] = text.trim().split(/\s+/u);
  const normalized = command.toLowerCase();
  return normalized === "/chatid" || normalized === `/chatid@${botUsername ?? ""}`;
}

type ChatMemberStatusCarrier = {
  status: string;
  is_member?: boolean;
  user: User;
};

function isJoinTransition(
  oldStatus: string,
  newStatus: string,
  newMember: ChatMemberStatusCarrier,
): boolean {
  const wasOut = oldStatus === "left" || oldStatus === "kicked";
  const isIn =
    newStatus === "member" ||
    newStatus === "administrator" ||
    newStatus === "creator" ||
    (newStatus === "restricted" && newMember.is_member === true);

  return wasOut && isIn;
}
