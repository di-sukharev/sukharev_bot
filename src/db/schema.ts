import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const telegramUsers = sqliteTable("telegram_users", {
  id: text("id").primaryKey().notNull(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  displayName: text("display_name").notNull(),
  isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const telegramChats = sqliteTable("telegram_chats", {
  id: text("id").primaryKey().notNull(),
  type: text("type").notNull(),
  title: text("title"),
  username: text("username"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const telegramMessages = sqliteTable(
  "telegram_messages",
  {
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    sentAt: integer("sent_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.chatId, table.messageId] }),
  }),
);

export const vibeLedger = sqliteTable("vibe_ledger", {
  idempotencyKey: text("idempotency_key").primaryKey().notNull(),
  chatId: text("chat_id").notNull(),
  recipientUserId: text("recipient_user_id").notNull(),
  actorUserId: text("actor_user_id"),
  delta: integer("delta").notNull(),
  source: text("source").notNull(),
  reason: text("reason").notNull(),
  sourceMessageId: integer("source_message_id"),
  targetMessageId: integer("target_message_id"),
  createdAt: text("created_at").notNull(),
});

export const processedUpdates = sqliteTable("processed_updates", {
  updateId: integer("update_id").primaryKey().notNull(),
  processedAt: text("processed_at").notNull(),
  status: text("status").notNull(),
  updatedAt: text("updated_at").notNull(),
  reservationToken: text("reservation_token").notNull(),
});

export const reactionAwards = sqliteTable(
  "reaction_awards",
  {
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    recipientUserId: text("recipient_user_id").notNull(),
    positiveReactionCount: integer("positive_reaction_count").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.chatId, table.messageId, table.actorUserId],
    }),
  }),
);

export const reactionVibeStates = sqliteTable(
  "reaction_vibe_states",
  {
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    actorId: text("actor_id").notNull(),
    recipientUserId: text("recipient_user_id").notNull(),
    positiveReactionCount: integer("positive_reaction_count").notNull(),
    // SQL keeps the original poop-only column name; runtime treats it as all negative reactions.
    negativeReactionCount: integer("poop_reaction_count").notNull(),
    lastUpdateDate: integer("last_update_date"),
    lastUpdateId: integer("last_update_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.chatId, table.messageId, table.actorId],
    }),
  }),
);

export const reactionAwardReservations = sqliteTable(
  "reaction_award_reservations",
  {
    chatId: text("chat_id").notNull(),
    messageId: integer("message_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    reservationToken: text("reservation_token").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.chatId, table.messageId, table.actorUserId],
    }),
  }),
);

export const moderationActions = sqliteTable("moderation_actions", {
  idempotencyKey: text("idempotency_key").primaryKey().notNull(),
  chatId: text("chat_id").notNull(),
  action: text("action").notNull(),
  targetUserId: text("target_user_id"),
  targetMessageId: integer("target_message_id"),
  status: text("status").notNull().default("completed"),
  reservationToken: text("reservation_token"),
  updatedAt: text("updated_at"),
  createdAt: text("created_at").notNull(),
});
