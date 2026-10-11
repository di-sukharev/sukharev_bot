import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
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
const MODERATION_RESERVATION_STALE_AFTER_MS = 120_000;
const NEGATIVE_REACTION_LIMIT_WINDOW_MS = 48 * 60 * 60 * 1000;

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

    async applyLimitedReactionVibe({ entry, state, requestNegativeCharge }) {
      const timestamp = nowIso();
      const cutoff = new Date(Date.parse(timestamp) - NEGATIVE_REACTION_LIMIT_WINDOW_MS).toISOString();
      const chargeRequested = Number(requestNegativeCharge);
      const chargeBindings = [
        chargeRequested, entry.chatId, entry.actorUserId,
        entry.recipientUserId, entry.idempotencyKey,
      ];
      const chargeSql = `CASE WHEN ? AND EXISTS (
        SELECT 1 FROM negative_reaction_limits
        WHERE chat_id = ? AND actor_id = ? AND recipient_user_id = ?
          AND idempotency_key = ?
      ) THEN 1 ELSE 0 END`;

      // D1 claims the pair allowance and records the permanent charge atomically.
      // Only current updates also replace the active reaction snapshot.
      const statements = [
        database.prepare(`
          INSERT INTO negative_reaction_limits
            (chat_id, actor_id, recipient_user_id, charged_at, idempotency_key)
          SELECT ?, ?, ?, ?, ?
          WHERE ? AND NOT EXISTS (
            SELECT 1 FROM vibe_ledger WHERE idempotency_key = ?
          )
          ON CONFLICT (chat_id, actor_id, recipient_user_id) DO UPDATE SET
            charged_at = excluded.charged_at,
            idempotency_key = excluded.idempotency_key
          WHERE negative_reaction_limits.charged_at <= ?
        `).bind(
          entry.chatId, entry.actorUserId, entry.recipientUserId, timestamp,
          entry.idempotencyKey, chargeRequested, entry.idempotencyKey, cutoff,
        ),
        database.prepare(`
          INSERT OR IGNORE INTO vibe_ledger (
            idempotency_key, chat_id, recipient_user_id, actor_user_id, delta,
            source, reason, source_message_id, target_message_id, created_at
          ) VALUES (?, ?, ?, ?, ? - ${chargeSql}, ?, ?, ?, ?, ?)
          RETURNING delta
        `).bind(
          entry.idempotencyKey, entry.chatId, entry.recipientUserId,
          entry.actorUserId, entry.delta, ...chargeBindings, entry.source,
          entry.reason, entry.sourceMessageId, entry.targetMessageId, timestamp,
        ),
      ];
      if (state) {
        statements.push(database.prepare(`
          INSERT INTO reaction_vibe_states (
            chat_id, message_id, actor_id, recipient_user_id,
            positive_reaction_count, poop_reaction_count,
            last_update_date, last_update_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (chat_id, message_id, actor_id) DO UPDATE SET
            recipient_user_id = excluded.recipient_user_id,
            positive_reaction_count = excluded.positive_reaction_count,
            poop_reaction_count = excluded.poop_reaction_count,
            last_update_date = excluded.last_update_date,
            last_update_id = excluded.last_update_id,
            updated_at = excluded.updated_at
          WHERE reaction_vibe_states.last_update_id IS NULL
            OR reaction_vibe_states.last_update_id <> excluded.last_update_id
        `).bind(
          state.chatId, state.messageId, state.actorId, state.recipientUserId,
          state.positiveReactionCount, state.negativeReactionCount,
          state.lastUpdateDate, state.lastUpdateId, timestamp,
        ));
      }
      const results = await database.batch<{ delta: number }>(statements);
      return {
        inserted: didChange(results[1]!),
        delta: results[1]?.results[0]?.delta ?? 0,
        negativeChargeApplied: didChange(results[0]!),
      };
    },

    async getReactionVibeState(chatId, messageId, actorId): Promise<ReactionVibeState> {
      const rows = await db
        .select({
          recipientUserId: reactionVibeStates.recipientUserId,
          positiveReactionCount: reactionVibeStates.positiveReactionCount,
          negativeReactionCount: reactionVibeStates.negativeReactionCount,
          lastUpdateDate: reactionVibeStates.lastUpdateDate,
          lastUpdateId: reactionVibeStates.lastUpdateId,
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
        recipientUserId: rows[0]?.recipientUserId ?? null,
        positiveReactionCount: Number(rows[0]?.positiveReactionCount ?? 0),
        negativeReactionCount: Number(rows[0]?.negativeReactionCount ?? 0),
        lastUpdateDate:
          rows[0]?.lastUpdateDate === null || rows[0]?.lastUpdateDate === undefined
            ? null
            : Number(rows[0].lastUpdateDate),
        lastUpdateId:
          rows[0]?.lastUpdateId === null || rows[0]?.lastUpdateId === undefined
            ? null
            : Number(rows[0].lastUpdateId),
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
      await db
        .insert(reactionVibeStates)
        .values({
          chatId: input.chatId,
          messageId: input.messageId,
          actorId: input.actorId,
          recipientUserId: input.recipientUserId,
          positiveReactionCount: input.positiveReactionCount,
          negativeReactionCount: input.negativeReactionCount,
          lastUpdateDate: input.lastUpdateDate,
          lastUpdateId: input.lastUpdateId,
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
            lastUpdateDate: input.lastUpdateDate,
            lastUpdateId: input.lastUpdateId,
            updatedAt: nowIso(),
          },
        })
        .run();
    },

    async getMessageNegativeReactionCount(chatId, messageId, excludedActorId) {
      const conditions = [
        eq(reactionVibeStates.chatId, chatId),
        eq(reactionVibeStates.messageId, messageId),
      ];
      if (excludedActorId) {
        conditions.push(ne(reactionVibeStates.actorId, excludedActorId));
      }

      const rows = await db
        .select({
          count: sql<number>`coalesce(sum(${reactionVibeStates.negativeReactionCount}), 0)`,
        })
        .from(reactionVibeStates)
        .where(and(...conditions));

      return Number(rows[0]?.count ?? 0);
    },

    async reserveModerationAction(input: ModerationActionInput) {
      const timestamp = nowIso();
      const reservationToken = crypto.randomUUID();
      const result = await db
        .insert(moderationActions)
        .values({
          idempotencyKey: input.idempotencyKey,
          chatId: input.chatId,
          action: input.action,
          targetUserId: input.targetUserId,
          targetMessageId: input.targetMessageId,
          status: "processing",
          reservationToken,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing()
        .run();

      if (didChange(result)) {
        return { ...input, status: "reserved", token: reservationToken };
      }

      const rows = await db
        .select({ status: moderationActions.status })
        .from(moderationActions)
        .where(eq(moderationActions.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (rows[0]?.status === "completed") {
        return { status: "completed" };
      }

      const staleBefore = new Date(
        Date.now() - MODERATION_RESERVATION_STALE_AFTER_MS,
      ).toISOString();
      const reserved = await db
        .update(moderationActions)
        .set({
          status: "processing",
          reservationToken,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(moderationActions.idempotencyKey, input.idempotencyKey),
            eq(moderationActions.status, "processing"),
            lt(moderationActions.updatedAt, staleBefore),
          ),
        )
        .run();

      return didChange(reserved)
        ? { ...input, status: "reserved", token: reservationToken }
        : { status: "processing" };
    },

    async completeModerationAction(reservation) {
      const completed = await db
        .update(moderationActions)
        .set({
          status: "completed",
          reservationToken: null,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(moderationActions.idempotencyKey, reservation.idempotencyKey),
            eq(moderationActions.status, "processing"),
            eq(moderationActions.reservationToken, reservation.token),
          ),
        )
        .run();
      if (!didChange(completed)) {
        throw new Error(
          `Moderation action reservation was lost: ${reservation.idempotencyKey}`,
        );
      }
    },

    async releaseModerationAction(reservation) {
      await db
        .delete(moderationActions)
        .where(
          and(
            eq(moderationActions.idempotencyKey, reservation.idempotencyKey),
            eq(moderationActions.status, "processing"),
            eq(moderationActions.reservationToken, reservation.token),
          ),
        )
        .run();
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
