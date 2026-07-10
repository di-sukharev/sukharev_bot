import { and, desc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  CommunityBotRepository,
  ModerationActionInput,
  ReactionVibeState,
  StoredTelegramMessage,
  TelegramChatProfile,
  TelegramUserProfile,
  VibeLedgerInput,
  VibeTopEntry,
} from "./types";
import {
  moderationActions,
  reactionAwardReservations,
  processedUpdates,
  reactionVibeStates,
  telegramChats,
  telegramMessages,
  telegramUsers,
  vibeLedger,
} from "./db/schema";

const UPDATE_RESERVATION_STALE_AFTER_MS = 120_000;
const REACTION_RESERVATION_STALE_AFTER_MS = 120_000;

type D1RunResult = {
  meta?: {
    changes?: number;
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function didChange(result: D1RunResult): boolean {
  return (result.meta?.changes ?? 0) > 0;
}

export function createD1CommunityBotRepository(
  database: D1Database,
): CommunityBotRepository {
  const db = drizzle(database);

  return {
    async reserveUpdateProcessing(updateId) {
      const timestamp = nowIso();
      const reservationToken = crypto.randomUUID();
      const inserted = await db
        .insert(processedUpdates)
        .values({
          updateId,
          processedAt: timestamp,
          status: "processing",
          updatedAt: timestamp,
          reservationToken,
        })
        .onConflictDoNothing()
        .run();

      if (didChange(inserted)) {
        return { status: "reserved", updateId, token: reservationToken };
      }

      const rows = await db
        .select({ status: processedUpdates.status })
        .from(processedUpdates)
        .where(eq(processedUpdates.updateId, updateId))
        .limit(1);

      if (rows[0]?.status === "processed") {
        return { status: "processed" };
      }

      const staleBefore = new Date(
        Date.now() - UPDATE_RESERVATION_STALE_AFTER_MS,
      ).toISOString();
      const reserved = await db
        .update(processedUpdates)
        .set({ status: "processing", updatedAt: timestamp, reservationToken })
        .where(
          and(
            eq(processedUpdates.updateId, updateId),
            eq(processedUpdates.status, "processing"),
            lt(processedUpdates.updatedAt, staleBefore),
          ),
        )
        .run();

      return didChange(reserved)
        ? { status: "reserved", updateId, token: reservationToken }
        : { status: "processing" };
    },

    async markUpdateProcessed(reservation) {
      const timestamp = nowIso();
      const result = await db
        .update(processedUpdates)
        .set({
          processedAt: timestamp,
          status: "processed",
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(processedUpdates.updateId, reservation.updateId),
            eq(processedUpdates.status, "processing"),
            eq(processedUpdates.reservationToken, reservation.token),
          ),
        )
        .run();

      return didChange(result);
    },

    async releaseUpdateReservation(reservation) {
      await db
        .delete(processedUpdates)
        .where(
          and(
            eq(processedUpdates.updateId, reservation.updateId),
            eq(processedUpdates.status, "processing"),
            eq(processedUpdates.reservationToken, reservation.token),
          ),
        )
        .run();
    },

    async upsertUser(user) {
      const timestamp = nowIso();

      await db
        .insert(telegramUsers)
        .values({
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          displayName: user.displayName,
          isBot: user.isBot,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: telegramUsers.id,
          set: {
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            displayName: user.displayName,
            isBot: user.isBot,
            updatedAt: timestamp,
          },
        })
        .run();
    },

    async upsertChat(chat) {
      const timestamp = nowIso();

      await db
        .insert(telegramChats)
        .values({
          id: chat.id,
          type: chat.type,
          title: chat.title,
          username: chat.username,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: telegramChats.id,
          set: {
            type: chat.type,
            title: chat.title,
            username: chat.username,
            updatedAt: timestamp,
          },
        })
        .run();
    },

    async storeMessage(message) {
      const timestamp = nowIso();

      await db
        .insert(telegramMessages)
        .values({
          chatId: message.chatId,
          messageId: message.messageId,
          authorUserId: message.authorUserId,
          sentAt: message.sentAt,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: [telegramMessages.chatId, telegramMessages.messageId],
          set: {
            authorUserId: message.authorUserId,
            sentAt: message.sentAt,
            updatedAt: timestamp,
          },
        })
        .run();
    },

    async findMessageAuthor(chatId, messageId) {
      const rows = await db
        .select({
          id: telegramUsers.id,
          username: telegramUsers.username,
          firstName: telegramUsers.firstName,
          lastName: telegramUsers.lastName,
          displayName: telegramUsers.displayName,
          isBot: telegramUsers.isBot,
        })
        .from(telegramMessages)
        .innerJoin(telegramUsers, eq(telegramMessages.authorUserId, telegramUsers.id))
        .where(
          and(
            eq(telegramMessages.chatId, chatId),
            eq(telegramMessages.messageId, messageId),
          ),
        )
        .limit(1);

      return rows[0] ?? null;
    },

    async addVibeLedgerEntry(input) {
      const result = await db
        .insert(vibeLedger)
        .values({
          idempotencyKey: input.idempotencyKey,
          chatId: input.chatId,
          recipientUserId: input.recipientUserId,
          actorUserId: input.actorUserId,
          delta: input.delta,
          source: input.source,
          reason: input.reason,
          sourceMessageId: input.sourceMessageId,
          targetMessageId: input.targetMessageId,
          createdAt: nowIso(),
        })
        .onConflictDoNothing()
        .run();

      return didChange(result);
    },

    async getReactionVibeState(chatId, messageId, actorId): Promise<ReactionVibeState> {
      const rows = await db
        .select({
          positiveReactionCount: reactionVibeStates.positiveReactionCount,
          negativeReactionCount: reactionVibeStates.negativeReactionCount,
        })
        .from(reactionVibeStates)
        .where(
          and(
            eq(reactionVibeStates.chatId, chatId),
            eq(reactionVibeStates.messageId, messageId),
            eq(reactionVibeStates.actorId, actorId),
          ),
        )
        .limit(1);

      return {
        positiveReactionCount: Number(rows[0]?.positiveReactionCount ?? 0),
        negativeReactionCount: Number(rows[0]?.negativeReactionCount ?? 0),
      };
    },

    async reserveReactionProcessing(chatId, messageId, actorId) {
      const timestamp = nowIso();
      const reservationToken = crypto.randomUUID();
      const inserted = await db
        .insert(reactionAwardReservations)
        .values({
          chatId,
          messageId,
          actorUserId: actorId,
          reservationToken,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();

      if (didChange(inserted)) {
        return { chatId, messageId, actorId, token: reservationToken };
      }

      const staleBefore = new Date(
        Date.now() - REACTION_RESERVATION_STALE_AFTER_MS,
      ).toISOString();
      const reserved = await db
        .update(reactionAwardReservations)
        .set({ reservationToken, updatedAt: timestamp })
        .where(
          and(
            eq(reactionAwardReservations.chatId, chatId),
            eq(reactionAwardReservations.messageId, messageId),
            eq(reactionAwardReservations.actorUserId, actorId),
            lt(reactionAwardReservations.updatedAt, staleBefore),
          ),
        )
        .run();

      return didChange(reserved)
        ? { chatId, messageId, actorId, token: reservationToken }
        : null;
    },

    async releaseReactionProcessing(reservation) {
      await db
        .delete(reactionAwardReservations)
        .where(
          and(
            eq(reactionAwardReservations.chatId, reservation.chatId),
            eq(reactionAwardReservations.messageId, reservation.messageId),
            eq(reactionAwardReservations.actorUserId, reservation.actorId),
            eq(reactionAwardReservations.reservationToken, reservation.token),
          ),
        )
        .run();
    },

    async setReactionVibeState(input) {
      if (input.positiveReactionCount <= 0 && input.negativeReactionCount <= 0) {
        await db
          .delete(reactionVibeStates)
          .where(
            and(
              eq(reactionVibeStates.chatId, input.chatId),
              eq(reactionVibeStates.messageId, input.messageId),
              eq(reactionVibeStates.actorId, input.actorId),
            ),
          )
          .run();
        return;
      }

      await db
        .insert(reactionVibeStates)
        .values({
          chatId: input.chatId,
          messageId: input.messageId,
          actorId: input.actorId,
          recipientUserId: input.recipientUserId,
          positiveReactionCount: input.positiveReactionCount,
          negativeReactionCount: input.negativeReactionCount,
          updatedAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: [
            reactionVibeStates.chatId,
            reactionVibeStates.messageId,
            reactionVibeStates.actorId,
          ],
          set: {
            recipientUserId: input.recipientUserId,
            positiveReactionCount: input.positiveReactionCount,
            negativeReactionCount: input.negativeReactionCount,
            updatedAt: nowIso(),
          },
        })
        .run();
    },

    async getMessageNegativeReactionCount(chatId, messageId) {
      const rows = await db
        .select({
          count: sql<number>`coalesce(sum(${reactionVibeStates.negativeReactionCount}), 0)`,
        })
        .from(reactionVibeStates)
        .where(
          and(
            eq(reactionVibeStates.chatId, chatId),
            eq(reactionVibeStates.messageId, messageId),
          ),
        );

      return Number(rows[0]?.count ?? 0);
    },

    async addModerationAction(input: ModerationActionInput) {
      const result = await db
        .insert(moderationActions)
        .values({
          idempotencyKey: input.idempotencyKey,
          chatId: input.chatId,
          action: input.action,
          targetUserId: input.targetUserId,
          targetMessageId: input.targetMessageId,
          createdAt: nowIso(),
        })
        .onConflictDoNothing()
        .run();

      return didChange(result);
    },

    async getVibeScore(chatId, userId) {
      const rows = await db
        .select({
          score: sql<number>`coalesce(sum(${vibeLedger.delta}), 0)`,
        })
        .from(vibeLedger)
        .where(and(eq(vibeLedger.chatId, chatId), eq(vibeLedger.recipientUserId, userId)));

      return Number(rows[0]?.score ?? 0);
    },

    async getVibeTop(chatId, limit): Promise<VibeTopEntry[]> {
      const score = sql<number>`sum(${vibeLedger.delta})`;
      const rows = await db
        .select({
          userId: vibeLedger.recipientUserId,
          displayName: telegramUsers.displayName,
          username: telegramUsers.username,
          score,
        })
        .from(vibeLedger)
        .innerJoin(telegramUsers, eq(vibeLedger.recipientUserId, telegramUsers.id))
        .where(eq(vibeLedger.chatId, chatId))
        .groupBy(vibeLedger.recipientUserId)
        .having(sql`sum(${vibeLedger.delta}) > 0`)
        .orderBy(desc(score))
        .limit(limit);

      return rows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        username: row.username,
        score: Number(row.score),
      }));
    },
  };
}
