import type {
  CommunityBotRepository,
  LimitedReactionVibeInput,
  ModerationActionInput,
  ModerationActionReservation,
  ReactionVibeState,
  ReactionVibeStateInput,
  StoredTelegramMessage,
  TelegramChatProfile,
  TelegramUserProfile,
  VibeLedgerInput,
  VibeTopEntry,
} from "../types";

export function createTestEnv(
  allowedChatIds = "-1001",
  overrides: Partial<{
    OWNER_USER_IDS: string;
    ANNOUNCE_REACTIONS: string;
    WELCOME_MUTED_UNTIL: string;
    LINK_ALLOWED_USERNAMES: string;
    VIBE_NOTIFICATION_DELETE_QUEUE: Queue<unknown>;
  }> = {},
) {
  return {
    DB: {} as D1Database,
    BOT_TOKEN: "123:test",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    ALLOWED_CHAT_IDS: allowedChatIds,
    OWNER_USER_IDS: "",
    ANNOUNCE_REACTIONS: "false",
    LINK_ALLOWED_USERNAMES: "",
    BOT_INFO: JSON.stringify({
      id: 123,
      is_bot: true,
      first_name: "Community Bot",
      username: "CommunityBot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    }),
    ...overrides,
  };
}

export type QueuedMessage<Body> = {
  message: Body;
  options?: QueueSendOptions;
};

export function createQueueMock<Body>() {
  const messages: Array<QueuedMessage<Body>> = [];
  const queue: Queue<Body> = {
    async metrics() {
      return {
        backlogCount: messages.length,
        backlogBytes: 0,
      };
    },
    async send(message, options) {
      messages.push({ message, options });
      return {
        metadata: {
          metrics: {
            backlogCount: messages.length,
            backlogBytes: 0,
          },
        },
      };
    },
    async sendBatch(batch, options) {
      for (const request of batch) {
        messages.push({
          message: request.body,
          options: {
            contentType: request.contentType,
            delaySeconds: request.delaySeconds ?? options?.delaySeconds,
          },
        });
      }

      return {
        metadata: {
          metrics: {
            backlogCount: messages.length,
            backlogBytes: 0,
          },
        },
      };
    },
  };

  return { messages, queue };
}

export function installTelegramFetchMock() {
  const requests: Array<{ url: string; body: unknown }> = [];

  return {
    requests,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = parseRequestBody(init?.body);
      requests.push({ url: String(input), body });

      if (String(input).endsWith("/getChatMember")) {
        return Response.json({
          ok: true,
          result: {
            status: "member",
            user: { id: (body as { user_id: number }).user_id, is_bot: false, first_name: "Member" },
          },
        });
      }

      const receiverUserId = (body as {
        ephemeral_message_parameters?: { receiver_user_id: number };
      })?.ephemeral_message_parameters?.receiver_user_id;
      if (String(input).endsWith("/sendMessage") && receiverUserId !== undefined) {
        return Response.json({
          ok: true,
          result: {
            message_id: 0,
            ephemeral_message_id: requests.length,
            receiver_user: { id: receiverUserId, is_bot: false, first_name: "Recipient" },
            date: 1,
            chat: { id: -1001, type: "supergroup", title: "Students" },
          },
        });
      }

      return Response.json({
        ok: true,
        result: {
          message_id: requests.length,
          date: 1,
          chat: { id: -1001, type: "supergroup", title: "Students" },
        },
      });
    }) as typeof fetch,
    restore() {
      requests.length = 0;
    },
  };
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body ?? null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export class InMemoryCommunityBotRepository implements CommunityBotRepository {
  readonly users = new Map<string, TelegramUserProfile>();
  readonly chats = new Map<string, TelegramChatProfile>();
  readonly messages = new Map<string, StoredTelegramMessage>();
  readonly ledger = new Map<string, VibeLedgerInput>();
  readonly processedUpdates = new Set<number>();
  readonly processingUpdates = new Map<number, string>();
  readonly reactionStates = new Map<string, ReactionVibeStateInput>();
  readonly reactionAwardReservations = new Map<string, string>();
  readonly negativeReactionLimits = new Map<string, number>();
  readonly negativeReactionCharges = new Map<string, Array<{
    key: string; amount: number; date: number; updateId: number;
  }>>();
  readonly moderationActions = new Map<string, ModerationActionInput>();
  readonly moderationActionReservations = new Map<
    string,
    ModerationActionReservation
  >();

  async reserveUpdateProcessing(updateId: number) {
    if (this.processedUpdates.has(updateId)) {
      return { status: "processed" as const };
    }
    if (this.processingUpdates.has(updateId)) {
      return { status: "processing" as const };
    }

    const token = `reservation-${updateId}-${this.processingUpdates.size}`;
    this.processingUpdates.set(updateId, token);
    return { status: "reserved" as const, updateId, token };
  }

  async markUpdateProcessed(reservation: {
    updateId: number;
    token: string;
  }): Promise<boolean> {
    if (
      this.processedUpdates.has(reservation.updateId) ||
      this.processingUpdates.get(reservation.updateId) !== reservation.token
    ) {
      return false;
    }

    this.processingUpdates.delete(reservation.updateId);
    this.processedUpdates.add(reservation.updateId);
    return true;
  }

  async releaseUpdateReservation(reservation: {
    updateId: number;
    token: string;
  }): Promise<void> {
    if (this.processingUpdates.get(reservation.updateId) === reservation.token) {
      this.processingUpdates.delete(reservation.updateId);
    }
  }

  async upsertUser(user: TelegramUserProfile): Promise<void> {
    this.users.set(user.id, user);
  }

  async upsertChat(chat: TelegramChatProfile): Promise<void> {
    this.chats.set(chat.id, chat);
  }

  async storeMessage(message: StoredTelegramMessage): Promise<void> {
    this.messages.set(messageKey(message.chatId, message.messageId), message);
  }

  async findMessageAuthor(
    chatId: string,
    messageId: number,
  ): Promise<TelegramUserProfile | null> {
    const message = this.messages.get(messageKey(chatId, messageId));
    if (!message) {
      return null;
    }

    return this.users.get(message.authorUserId) ?? null;
  }

  async addVibeLedgerEntry(input: VibeLedgerInput): Promise<boolean> {
    if (this.ledger.has(input.idempotencyKey)) {
      return false;
    }

    this.ledger.set(input.idempotencyKey, input);
    return true;
  }

  async applyLimitedReactionVibe({ entry, state, oldNegativeReactionCount, requestNegativeCharge, writeState }: LimitedReactionVibeInput) {
    if (this.ledger.has(entry.idempotencyKey)) {
      return { inserted: false, delta: 0, negativeChargeApplied: false };
    }
    const stateKey = reactionAwardKey(state.chatId, state.messageId, state.actorId);
    const charges = this.negativeReactionCharges.get(stateKey) ?? [];
    charges.sort((a, b) => a.date - b.date || a.updateId - b.updateId);
    let capacity = Math.min(oldNegativeReactionCount, state.negativeReactionCount);
    let refund = 0;
    for (const charge of [...charges].reverse()) {
      if (charge.date < state.lastUpdateDate ||
        (charge.date === state.lastUpdateDate && charge.updateId < state.lastUpdateId)) {
        const retained = Math.min(charge.amount, capacity);
        capacity -= retained;
        refund += charge.amount - retained;
        charge.amount = retained;
      }
    }
    const key = `${state.chatId}:${state.actorId}:${state.recipientUserId}`;
    const now = Date.now();
    const lastCharge = this.negativeReactionLimits.get(key);
    const charge = Number(requestNegativeCharge &&
      (lastCharge === undefined || now - lastCharge >= 48 * 60 * 60 * 1000));
    if (charge) {
      this.negativeReactionLimits.set(key, now);
      charges.push({ key: entry.idempotencyKey, amount: 1,
        date: state.lastUpdateDate, updateId: state.lastUpdateId });
    }
    this.negativeReactionCharges.set(stateKey, charges.filter(charge => charge.amount > 0));
    const delta = entry.delta + refund - charge;
    this.ledger.set(entry.idempotencyKey, { ...entry, delta });
    if (writeState) this.reactionStates.set(stateKey, state);
    return { inserted: true, delta, negativeChargeApplied: charge > 0 };
  }

  async getReactionVibeState(
    chatId: string,
    messageId: number,
    actorId: string,
  ): Promise<ReactionVibeState> {
    const state = this.reactionStates.get(reactionAwardKey(chatId, messageId, actorId));
    return {
      recipientUserId: state?.recipientUserId ?? null,
      positiveReactionCount: state?.positiveReactionCount ?? 0,
      negativeReactionCount: state?.negativeReactionCount ?? 0,
      chargedNegativeReactionCount: (this.negativeReactionCharges.get(
        reactionAwardKey(chatId, messageId, actorId),
      ) ?? []).reduce((sum, charge) => sum + charge.amount, 0),
      lastUpdateDate: state?.lastUpdateDate ?? null,
      lastUpdateId: state?.lastUpdateId ?? null,
    };
  }

  async reserveReactionProcessing(
    chatId: string,
    messageId: number,
    actorId: string,
  ): Promise<{
    chatId: string;
    messageId: number;
    actorId: string;
    token: string;
  } | null> {
    const key = reactionAwardKey(chatId, messageId, actorId);
    if (this.reactionAwardReservations.has(key)) {
      return null;
    }

    const token = `reaction-reservation-${this.reactionAwardReservations.size}`;
    this.reactionAwardReservations.set(key, token);
    return { chatId, messageId, actorId, token };
  }

  async releaseReactionProcessing(reservation: {
    chatId: string;
    messageId: number;
    actorId: string;
    token: string;
  }): Promise<void> {
    const key = reactionAwardKey(
      reservation.chatId,
      reservation.messageId,
      reservation.actorId,
    );
    if (this.reactionAwardReservations.get(key) === reservation.token) {
      this.reactionAwardReservations.delete(key);
    }
  }

  async setReactionVibeState(input: ReactionVibeStateInput): Promise<void> {
    const key = reactionAwardKey(input.chatId, input.messageId, input.actorId);
    this.reactionStates.set(key, input);
  }

  async getMessageNegativeReactionCount(
    chatId: string,
    messageId: number,
    excludedActorId: string | null,
  ): Promise<number> {
    return [...this.reactionStates.values()]
      .filter((state) => {
        return (
          state.chatId === chatId &&
          state.messageId === messageId &&
          state.actorId !== excludedActorId
        );
      })
      .reduce((sum, state) => sum + state.negativeReactionCount, 0);
  }

  async reserveModerationAction(input: ModerationActionInput) {
    if (this.moderationActions.has(input.idempotencyKey)) {
      return { status: "completed" as const };
    }
    if (this.moderationActionReservations.has(input.idempotencyKey)) {
      return { status: "processing" as const };
    }

    const reservation = {
      ...input,
      status: "reserved" as const,
      token: `moderation-reservation-${this.moderationActionReservations.size}`,
    };
    this.moderationActionReservations.set(input.idempotencyKey, reservation);
    return reservation;
  }

  async completeModerationAction(
    reservation: ModerationActionReservation,
  ): Promise<void> {
    if (
      this.moderationActionReservations.get(reservation.idempotencyKey)?.token !==
      reservation.token
    ) {
      throw new Error(
        `Moderation action reservation was lost: ${reservation.idempotencyKey}`,
      );
    }

    this.moderationActionReservations.delete(reservation.idempotencyKey);
    this.moderationActions.set(reservation.idempotencyKey, reservation);
  }

  async releaseModerationAction(
    reservation: ModerationActionReservation,
  ): Promise<void> {
    if (
      this.moderationActionReservations.get(reservation.idempotencyKey)?.token ===
      reservation.token
    ) {
      this.moderationActionReservations.delete(reservation.idempotencyKey);
    }
  }

  async getVibeScore(chatId: string, userId: string): Promise<number> {
    return [...this.ledger.values()]
      .filter((entry) => entry.chatId === chatId && entry.recipientUserId === userId)
      .reduce((sum, entry) => sum + entry.delta, 0);
  }

  async getVibeTop(chatId: string, limit: number): Promise<VibeTopEntry[]> {
    const scores = new Map<string, number>();
    for (const entry of this.ledger.values()) {
      if (entry.chatId !== chatId) {
        continue;
      }

      scores.set(entry.recipientUserId, (scores.get(entry.recipientUserId) ?? 0) + entry.delta);
    }

    return [...scores.entries()]
      .filter(([, score]) => score > 0)
      .sort(([, leftScore], [, rightScore]) => rightScore - leftScore)
      .slice(0, limit)
      .map(([userId, score]) => {
        const user = this.users.get(userId);
        return {
          userId,
          displayName: user?.displayName ?? userId,
          username: user?.username ?? null,
          score,
        };
      });
  }
}

function messageKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function reactionAwardKey(
  chatId: string,
  messageId: number,
  actorId: string,
): string {
  return `${chatId}:${messageId}:${actorId}`;
}
