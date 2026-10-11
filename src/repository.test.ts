import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Update } from "grammy/types";
import { Miniflare } from "miniflare";
import { createCommunityBot } from "./bot";
import { createTestEnv, installTelegramFetchMock } from "./__tests__/helpers";
import { createD1CommunityBotRepository } from "./repository";
import type {
  CommunityBotRepository,
  LimitedReactionVibeInput,
  ModerationActionInput,
} from "./types";

let miniflare: Miniflare;
let database: D1Database;
let repository: CommunityBotRepository;

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: "2026-06-02",
    d1Databases: { DB: "moderation-test", LEGACY: "legacy-test" },
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
  });
  database = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  const migrations = Array.from(new Bun.Glob("*.sql").scanSync("drizzle/migrations")).sort();
  for (const migration of migrations) {
    await applyMigration(database, migration);
  }
  repository = createD1CommunityBotRepository(database);
});

describe("D1 negative reaction limits", () => {
  test("migrates legacy scores, refundable reactions, and recent pair allowances", async () => {
    const legacyDb = (await miniflare.getD1Database("LEGACY")) as unknown as D1Database;
    const migrations = Array.from(new Bun.Glob("*.sql").scanSync("drizzle/migrations")).sort();
    for (const migration of migrations.filter(name => name < "0007_negative_reaction_limits.sql")) {
      await applyMigration(legacyDb, migration);
    }
    await legacyDb.prepare(
      "INSERT INTO telegram_users (id, display_name, is_bot) VALUES ('10', 'Author', 0), ('30', 'Bot', 1)",
    ).run();
    await legacyDb.prepare(`INSERT INTO reaction_vibe_states (
      chat_id, message_id, actor_id, recipient_user_id,
      positive_reaction_count, poop_reaction_count, updated_at
    ) VALUES ('-1001', 1, 'legacy-actor', '10', 0, 2, ?),
      ('-1001', 2, 'legacy-actor', '__unknown_message_author__', 0, 1, ?),
      ('-1001', 3, 'legacy-actor', '30', 0, 1, ?),
      ('-1001', 4, '__reaction_count__', '10', 0, 3, ?)`)
      .bind(...Array(4).fill(new Date().toISOString())).run();
    const oldCharge = limitedReactionInput("legacy-actor", 1).entry;
    await createD1CommunityBotRepository(legacyDb).addVibeLedgerEntry({ ...oldCharge, delta: -2 });

    await applyMigration(legacyDb, "0007_negative_reaction_limits.sql");
    const legacyRepo = createD1CommunityBotRepository(legacyDb);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(-2);
    expect((await legacyRepo.getReactionVibeState("-1001", 1, "legacy-actor"))
      .chargedNegativeReactionCount).toBe(2);
    for (const [messageId, actorId] of [[2, "legacy-actor"], [3, "legacy-actor"], [4, "__reaction_count__"]] as const) {
      expect((await legacyRepo.getReactionVibeState("-1001", messageId, actorId))
        .chargedNegativeReactionCount).toBe(0);
    }

    const refund = limitedReactionInput("legacy-actor", 1);
    refund.entry.idempotencyKey = "legacy-refund";
    refund.entry.delta = 2;
    refund.state.negativeReactionCount = 0;
    refund.requestNegativeCharge = false;
    await legacyRepo.applyLimitedReactionVibe(refund);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(0);
    expect((await legacyRepo.applyLimitedReactionVibe(limitedReactionInput("legacy-actor", 5)))
      .negativeChargeApplied).toBe(false);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(0);
  });

  test("limits concurrent real bot updates across messages and keeps refunds exact", async () => {
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(
      createTestEnv("-1001,-1002", { ANNOUNCE_REACTIONS: "true" }),
      { repository, apiFetch: telegram.fetch },
    );
    try {
      for (const messageId of [100, 101, 102]) {
        await bot.handleUpdate(storedMessageUpdate(messageId, messageId));
      }
      const updates = [100, 101, 102].map((messageId, index) =>
        negativeReactionUpdate(200 + index, messageId));
      await Promise.all(updates.map(update => bot.handleUpdate(update)));
      await Promise.all(updates.map(update => bot.handleUpdate(update)));
      expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
      expect(telegram.requests.filter(request => request.url.endsWith("/sendMessage"))).toHaveLength(1);

      for (const messageId of [100, 101, 102]) {
        await bot.handleUpdate(negativeReactionUpdate(300 + messageId, messageId, { remove: true }));
      }
      expect(await repository.getVibeScore("-1001", "10")).toBe(0);
      await bot.handleUpdate(negativeReactionUpdate(500, 100));
      expect(await repository.getVibeScore("-1001", "10")).toBe(0);
      expect(telegram.requests.filter(request => request.url.endsWith("/sendMessage"))).toHaveLength(1);

      // Each actor, recipient, and chat has an independent allowance.
      await bot.handleUpdate(negativeReactionUpdate(501, 100, { actorId: 21 }));
      await bot.handleUpdate(storedMessageUpdate(502, 103, 11));
      await bot.handleUpdate(negativeReactionUpdate(503, 103));
      await bot.handleUpdate(storedMessageUpdate(504, 104, 10, -1002));
      await bot.handleUpdate(negativeReactionUpdate(505, 104, { chatId: -1002 }));
      expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
      expect(await repository.getVibeScore("-1001", "11")).toBe(-1);
      expect(await repository.getVibeScore("-1002", "10")).toBe(-1);
    } finally {
      telegram.restore();
    }
  });

  test("rolls back allowance and ledger on a failed state write and safely retries", async () => {
    const input = limitedReactionInput("transaction-failure", 1);
    await database.prepare(`CREATE TRIGGER fail_reaction_state
      BEFORE INSERT ON reaction_vibe_states WHEN NEW.actor_id = 'transaction-failure'
      BEGIN SELECT RAISE(ABORT, 'test state write failure'); END`).run();
    try {
      await expect(repository.applyLimitedReactionVibe(input)).rejects.toThrow();
      expect(await database.prepare(
        "SELECT COUNT(*) AS count FROM negative_reaction_limits WHERE actor_id = ?",
      ).bind(input.state.actorId).first<number>("count")).toBe(0);
      expect(await database.prepare(
        "SELECT COUNT(*) AS count FROM vibe_ledger WHERE idempotency_key = ?",
      ).bind(input.entry.idempotencyKey).first<number>("count")).toBe(0);
    } finally {
      await database.prepare("DROP TRIGGER fail_reaction_state").run();
    }

    expect(await repository.applyLimitedReactionVibe(input)).toEqual({
      inserted: true, delta: -1, negativeChargeApplied: true,
    });
    expect(await repository.applyLimitedReactionVibe(input)).toEqual({
      inserted: false, delta: 0, negativeChargeApplied: false,
    });
    expect((await repository.getReactionVibeState(
      input.state.chatId, input.state.messageId, input.state.actorId,
    )).chargedNegativeReactionCount).toBe(1);
  });

  test("uses a rolling D1 allowance without extending it for denied reactions", async () => {
    const start = Date.parse("2026-10-10T12:00:00.000Z");
    setSystemTime(start);
    try {
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 1),
      )).negativeChargeApplied).toBe(true);
      setSystemTime(start + 24 * 60 * 60 * 1000 - 1);
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 2),
      )).negativeChargeApplied).toBe(false);
      setSystemTime(start + 24 * 60 * 60 * 1000);
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 3),
      )).negativeChargeApplied).toBe(true);
    } finally {
      setSystemTime();
    }
  });
});

async function applyMigration(db: D1Database, filename: string) {
  const source = await Bun.file(`drizzle/migrations/${filename}`).text();
  for (const statement of source.split(";").filter(statement => statement.trim())) {
    await db.prepare(statement).run();
  }
}

function limitedReactionInput(actorId: string, messageId: number): LimitedReactionVibeInput {
  return {
    entry: {
      idempotencyKey: `${actorId}:${messageId}`,
      chatId: "-1001", recipientUserId: "10", actorUserId: actorId, delta: 0,
      source: "message_reaction", reason: "reaction vibe delta",
      sourceMessageId: null, targetMessageId: messageId,
    },
    state: {
      chatId: "-1001", messageId, actorId, recipientUserId: "10",
      positiveReactionCount: 0, negativeReactionCount: 1,
      chargedNegativeReactionCount: 0, lastUpdateDate: messageId, lastUpdateId: messageId,
    },
    requestNegativeCharge: true,
  };
}

function storedMessageUpdate(updateId: number, messageId: number, authorId = 10, chatId = -1001): Update {
  return {
    update_id: updateId,
    message: {
      message_id: messageId, date: updateId,
      chat: { id: chatId, type: "supergroup", title: "Test" },
      from: { id: authorId, is_bot: false, first_name: "Author" },
      text: "Test message",
    },
  };
}

function negativeReactionUpdate(
  updateId: number, messageId: number,
  options: { remove?: boolean; actorId?: number; chatId?: number } = {},
): Update {
  const reaction = { type: "emoji" as const, emoji: "👎" as const };
  return {
    update_id: updateId,
    message_reaction: {
      chat: { id: options.chatId ?? -1001, type: "supergroup", title: "Test" },
      message_id: messageId, date: updateId,
      user: { id: options.actorId ?? 20, is_bot: false, first_name: "Actor" },
      old_reaction: options.remove ? [reaction] : [],
      new_reaction: options.remove ? [] : [reaction],
    },
  };
}

afterAll(async () => {
  await miniflare.dispose();
});

describe("D1 moderation action reservations", () => {
  test("protects fresh reservations and recovers stale ones by token", async () => {
    const input: ModerationActionInput = {
      idempotencyKey: "delete_message:-1001:42",
      chatId: "-1001",
      action: "delete_message",
      targetUserId: "10",
      targetMessageId: 42,
    };

    const first = await repository.reserveModerationAction(input);
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") {
      throw new Error("Expected the first reservation to be acquired");
    }

    expect(await repository.reserveModerationAction(input)).toEqual({
      status: "processing",
    });

    await database
      .prepare(
        "UPDATE moderation_actions SET updated_at = ? WHERE idempotency_key = ?",
      )
      .bind("2000-01-01T00:00:00.000Z", input.idempotencyKey)
      .run();

    const takeover = await repository.reserveModerationAction(input);
    expect(takeover.status).toBe("reserved");
    if (takeover.status !== "reserved") {
      throw new Error("Expected the stale reservation to be recovered");
    }
    expect(takeover.token).not.toBe(first.token);

    await expect(repository.completeModerationAction(first)).rejects.toThrow(
      "Moderation action reservation was lost",
    );
    await repository.releaseModerationAction(first);

    const active = await database
      .prepare(
        "SELECT status, reservation_token FROM moderation_actions WHERE idempotency_key = ?",
      )
      .bind(input.idempotencyKey)
      .first<{ status: string; reservation_token: string | null }>();
    expect(active).toEqual({
      status: "processing",
      reservation_token: takeover.token,
    });

    await repository.completeModerationAction(takeover);
    expect(await repository.reserveModerationAction(input)).toEqual({
      status: "completed",
    });
  });
});
