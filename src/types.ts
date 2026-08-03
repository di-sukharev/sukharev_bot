import type { Chat, User } from "grammy/types";
import type { VibeNotificationDeleteJob } from "./vibe-notification-delete";

export type WorkerEnv = {
  DB: D1Database;
  BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_IDS?: string;
  OWNER_USER_IDS?: string;
  BOT_INFO?: string;
  ANNOUNCE_REACTIONS?: string;
  WELCOME_MUTED_UNTIL?: string;
  LINK_ALLOWED_USERNAMES?: string;
  VIBE_NOTIFICATION_DELETE_QUEUE?: Queue<VibeNotificationDeleteJob>;
};

export type RuntimeConfig = {
  allowedChatIds: Set<string>;
  ownerUserIds: Set<string>;
  announceReactions: boolean;
  welcomeMutedUntilMs: number | null;
  linkAllowedUsernames: Set<string>;
  botUsername: string | null;
  profanityWords: readonly string[];
};

export type TelegramUserProfile = {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  isBot: boolean;
};

export type TelegramChatProfile = {
  id: string;
  type: string;
  title: string | null;
  username: string | null;
};

export type StoredTelegramMessage = {
  chatId: string;
  messageId: number;
  authorUserId: string;
  sentAt: number | null;
};

export type VibeLedgerInput = {
  idempotencyKey: string;
  chatId: string;
  recipientUserId: string;
  actorUserId: string | null;
  delta: number;
  source: "thanks_reply" | "message_reaction" | "profanity";
  reason: string;
  sourceMessageId: number | null;
  targetMessageId: number | null;
};

export type VibeTopEntry = {
  userId: string;
  displayName: string;
  username: string | null;
  score: number;
};

export type ReactionVibeState = {
  recipientUserId: string | null;
  positiveReactionCount: number;
  negativeReactionCount: number;
  lastUpdateDate: number | null;
  lastUpdateId: number | null;
};

export type ReactionVibeStateInput = {
  chatId: string;
  messageId: number;
  actorId: string;
  recipientUserId: string;
  positiveReactionCount: number;
  negativeReactionCount: number;
  lastUpdateDate: number;
  lastUpdateId: number;
};

export type ReservedUpdateProcessing = {
  status: "reserved";
  updateId: number;
  token: string;
};

export type UpdateProcessingReservation =
  | ReservedUpdateProcessing
  | { status: "processed" }
  | { status: "processing" };

export type ReactionProcessingReservation = {
  chatId: string;
  messageId: number;
  actorId: string;
  token: string;
};

export type ModerationActionInput = {
  idempotencyKey: string;
  chatId: string;
  action: "delete_message" | "ban_user" | "send_warning";
  targetUserId: string | null;
  targetMessageId: number | null;
};

export type ModerationActionReservation = ModerationActionInput & {
  status: "reserved";
  token: string;
};

export type ModerationActionReservationResult =
  | ModerationActionReservation
  | { status: "completed" }
  | { status: "processing" };

export type CommunityBotRepository = {
  reserveUpdateProcessing(updateId: number): Promise<UpdateProcessingReservation>;
  markUpdateProcessed(reservation: ReservedUpdateProcessing): Promise<boolean>;
  releaseUpdateReservation(reservation: ReservedUpdateProcessing): Promise<void>;
  upsertUser(user: TelegramUserProfile): Promise<void>;
  upsertChat(chat: TelegramChatProfile): Promise<void>;
  storeMessage(message: StoredTelegramMessage): Promise<void>;
  findMessageAuthor(
    chatId: string,
    messageId: number,
  ): Promise<TelegramUserProfile | null>;
  addVibeLedgerEntry(input: VibeLedgerInput): Promise<boolean>;
  getReactionVibeState(
    chatId: string,
    messageId: number,
    actorId: string,
  ): Promise<ReactionVibeState>;
  setReactionVibeState(input: ReactionVibeStateInput): Promise<void>;
  reserveReactionProcessing(
    chatId: string,
    messageId: number,
    actorId: string,
  ): Promise<ReactionProcessingReservation | null>;
  releaseReactionProcessing(
    reservation: ReactionProcessingReservation,
  ): Promise<void>;
  getMessageNegativeReactionCount(
    chatId: string,
    messageId: number,
    excludedActorId: string | null,
  ): Promise<number>;
  reserveModerationAction(
    input: ModerationActionInput,
  ): Promise<ModerationActionReservationResult>;
  completeModerationAction(
    reservation: ModerationActionReservation,
  ): Promise<void>;
  releaseModerationAction(
    reservation: ModerationActionReservation,
  ): Promise<void>;
  getVibeScore(chatId: string, userId: string): Promise<number>;
  getVibeTop(chatId: string, limit: number): Promise<VibeTopEntry[]>;
};

export function telegramUserToProfile(user: User): TelegramUserProfile {
  const firstName = user.first_name?.trim() || null;
  const lastName = user.last_name?.trim() || null;
  const username = user.username?.trim() || null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    id: String(user.id),
    username,
    firstName,
    lastName,
    displayName: fullName || (username ? `@${username}` : `user ${user.id}`),
    isBot: user.is_bot,
  };
}

export function telegramChatToProfile(chat: Chat): TelegramChatProfile {
  const chatWithTitle = chat as Chat & {
    title?: string;
    username?: string;
  };

  return {
    id: String(chat.id),
    type: chat.type,
    title: chatWithTitle.title?.trim() || null,
    username: chatWithTitle.username?.trim() || null,
  };
}
