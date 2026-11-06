import type { Chat, User } from "grammy/types";
import type { ChannelJoinJob, ChannelProfileJob } from "./channel-join-monitor";
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
  MONITORED_CHANNEL_IDS?: string;
  CHANNEL_ALERT_USER_ID?: string;
  VIBE_NOTIFICATION_DELETE_QUEUE?: Queue<VibeNotificationDeleteJob>;
  CHANNEL_JOIN_QUEUE?: Queue<ChannelJoinJob>;
  CHANNEL_PROFILE_QUEUE?: Queue<ChannelProfileJob>;
};

export type RuntimeConfig = {
  allowedChatIds: Set<string>;
  monitoredChannelIds: Set<string>;
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

export type LimitedReactionVibeInput = {
  // The base delta contains only positive reaction changes.
  entry: VibeLedgerInput & { actorUserId: string };
  // Stale additions can charge permanently without replacing the active snapshot.
  state: ReactionVibeStateInput | null;
  requestNegativeCharge: boolean;
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

// A join waits as checking while the bot reads the profile, and as ban_failed
// while a due ban is not confirmed by Telegram.
export type ChannelJoinOutcome = "allowed" | "checking" | "banned" | "ban_failed";

export type ChannelJoinInput = {
  updateId: number;
  chatId: string;
  user: TelegramUserProfile;
  isPremium: boolean;
  languageCode: string | null;
  // Telegram Unix time of the membership change.
  joinedAt: number;
  outcome: Exclude<ChannelJoinOutcome, "banned">;
};

// The joins after `after`, up to `until`, in Telegram Unix time.
export type ChannelJoinWindow = {
  after: number;
  until: number;
};

export type ChannelJoinActivity = {
  // The joins of each window, counted up to the limit.
  joins: number[];
  lastAlertAt: number | null;
};

export type ChannelJoinProfile = {
  hasBio: boolean;
  hasPersonalChat: boolean;
  hasEmojiStatus: boolean;
  hasProfileAudio: boolean;
  hasPhoto: boolean;
};

export type ChannelJoinEntry = {
  userId: string;
  displayName: string;
  username: string | null;
  outcome: ChannelJoinOutcome;
};

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
  applyLimitedReactionVibe(
    input: LimitedReactionVibeInput,
  ): Promise<{ inserted: boolean; delta: number; negativeChargeApplied: boolean }>;
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

export type ChannelJoinRepository = {
  // Stores new joins and returns the stored outcome of each join. A redelivered
  // join keeps its first row.
  recordChannelJoins(joins: readonly ChannelJoinInput[]): Promise<ChannelJoinOutcome[]>;
  getChannelJoinActivity(
    chatId: string,
    windows: readonly ChannelJoinWindow[],
    limit: number,
  ): Promise<ChannelJoinActivity>;
  setChannelJoinOutcome(updateId: number, outcome: ChannelJoinOutcome): Promise<void>;
  saveChannelJoinProfile(updateId: number, profile: ChannelJoinProfile): Promise<void>;
  // Lists the joins of the window in join order.
  listChannelJoins(chatId: string, window: ChannelJoinWindow): Promise<ChannelJoinEntry[]>;
  markChannelAlerted(chatId: string, alertedAt: number): Promise<void>;
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
