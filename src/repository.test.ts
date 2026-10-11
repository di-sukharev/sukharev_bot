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
  test("keeps positive scoring when an out-of-order snapshot refunds a negative charge", async () => {
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(6800, 6800, 6800));
      await bot.handleUpdate(negativeReactionUpdate(6801, 6800, {
        actorId: 68, newEmojis: ["👎", "👍"],
      }));
      await bot.handleUpdate(negativeReactionUpdate(6803, 6800, {
        actorId: 68, oldEmojis: ["👍"], newEmojis: ["👎", "👍"],
      }));
      await bot.handleUpdate(negativeReactionUpdate(6802, 6800, {
        actorId: 68, oldEmojis: ["👎", "👍"], newEmojis: ["👍"],
      }));
      expect(await repository.getVibeScore("-1001", "6800")).toBe(1);
      expect(await repository.getReactionVibeState("-1001", 6800, "68"))
        .toMatchObject({ positiveReactionCount: 1, negativeReactionCount: 1,
          chargedNegativeReactionCount: 0, lastUpdateId: 6803 });
    } finally {
      telegram.restore();
    }
  });

  test("refunds a removed charge when removal and re-addition arrive out of order", async () => {
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(600, 600, 600));
      await bot.handleUpdate(negativeReactionUpdate(601, 600, { actorId: 60 }));
      await bot.handleUpdate(negativeReactionUpdate(603, 600, { actorId: 60 }));
      await bot.handleUpdate(negativeReactionUpdate(602, 600, { actorId: 60, remove: true }));

      expect((await repository.getReactionVibeState("-1001", 600, "60")))
        .toMatchObject({ negativeReactionCount: 1, chargedNegativeReactionCount: 0, lastUpdateId: 603 });
      expect(await database.prepare(
        "SELECT SUM(delta) AS score FROM vibe_ledger WHERE actor_user_id = '60'",
      ).first<number>("score")).toBe(0);
    } finally {
      telegram.restore();
    }
  });

  test.each(["switch", "add"] as const)(
    "refunds an earlier charge with newest-first remove, re-add, and %s snapshots",
    async variant => {
      const actorId = variant === "switch" ? 61 : 62;
      const messageId = actorId * 100;
      const telegram = installTelegramFetchMock();
      const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
      try {
        await bot.handleUpdate(storedMessageUpdate(messageId, messageId, messageId));
        await bot.handleUpdate(negativeReactionUpdate(messageId + 1, messageId, { actorId }));
        const anchor = await database.prepare(
          "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
        ).bind(String(actorId)).first<string>("charged_at");
        await bot.handleUpdate(negativeReactionUpdate(messageId + 4, messageId, {
          actorId, oldEmojis: ["👎"], newEmojis: variant === "switch" ? ["💩"] : ["👎", "💩"],
        }));
        await bot.handleUpdate(negativeReactionUpdate(messageId + 3, messageId, { actorId }));
        const removal = negativeReactionUpdate(messageId + 2, messageId, { actorId, remove: true });
        await bot.handleUpdate(removal);
        await bot.handleUpdate(removal);
        expect(await database.prepare(
          "SELECT SUM(delta) AS score FROM vibe_ledger WHERE actor_user_id = ?",
        ).bind(String(actorId)).first<number>("score")).toBe(0);
        expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
          .toMatchObject({ negativeReactionCount: variant === "switch" ? 1 : 2,
            chargedNegativeReactionCount: 0, lastUpdateId: messageId + 4 });
        expect(await database.prepare(
          "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
        ).bind(String(actorId)).first<string>("charged_at")).toBe(anchor);
      } finally {
        telegram.restore();
      }
    },
  );

  test("a stale removal refunds only the earlier charge after a new window charge", async () => {
    const start = Date.parse("2026-10-10T12:00:00.000Z");
    const actorId = 63;
    const messageId = 6300;
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    setSystemTime(start);
    try {
      await bot.handleUpdate(storedMessageUpdate(messageId, messageId, messageId));
      await bot.handleUpdate(negativeReactionUpdate(messageId + 1, messageId, { actorId }));
      setSystemTime(start + 48 * 60 * 60 * 1000);
      await bot.handleUpdate(negativeReactionUpdate(messageId + 4, messageId, {
        actorId, oldEmojis: ["👎"], newEmojis: ["👎", "💩"],
      }));
      expect(await database.prepare(
        "SELECT SUM(delta) AS score FROM vibe_ledger WHERE actor_user_id = ?",
      ).bind(String(actorId)).first<number>("score")).toBe(-2);
      await bot.handleUpdate(negativeReactionUpdate(messageId + 3, messageId, { actorId }));
      const removal = negativeReactionUpdate(messageId + 2, messageId, { actorId, remove: true });
      await bot.handleUpdate(removal);
      await bot.handleUpdate(removal);
      expect(await database.prepare(
        "SELECT SUM(delta) AS score FROM vibe_ledger WHERE actor_user_id = ?",
      ).bind(String(actorId)).first<number>("score")).toBe(-1);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({ negativeReactionCount: 2, chargedNegativeReactionCount: 1,
          lastUpdateId: messageId + 4 });
      expect(await database.prepare(
        "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
      ).bind(String(actorId)).first<string>("charged_at"))
        .toBe(new Date(start + 48 * 60 * 60 * 1000).toISOString());
    } finally {
      setSystemTime();
      telegram.restore();
    }
  });

  test.each([
    { newestFirst: false, expiresAgain: false, actorId: 65 },
    { newestFirst: true, expiresAgain: false, actorId: 66 },
    { newestFirst: true, expiresAgain: true, actorId: 67 },
  ])("reconciles partial removal and re-addition: %j", async ({ newestFirst, expiresAgain, actorId }) => {
    const messageId = actorId * 100;
    const start = Date.parse("2026-10-10T12:00:00.000Z");
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    setSystemTime(start);
    try {
      await bot.handleUpdate(storedMessageUpdate(messageId, messageId, messageId));
      await bot.handleUpdate(negativeReactionUpdate(messageId + 1, messageId, { actorId }));
      setSystemTime(start + 48 * 60 * 60 * 1000);
      await bot.handleUpdate(negativeReactionUpdate(messageId + 2, messageId, {
        actorId, oldEmojis: ["👎"], newEmojis: ["👎", "💩"],
      }));
      const anchor = await database.prepare(
        "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
      ).bind(String(actorId)).first<string>("charged_at");
      const remove = negativeReactionUpdate(messageId + 3, messageId, {
        actorId, oldEmojis: ["👎", "💩"], newEmojis: ["👎"],
      });
      const reAdd = negativeReactionUpdate(messageId + 4, messageId, {
        actorId, oldEmojis: ["👎"], newEmojis: ["👎", "💩"],
      });
      if (expiresAgain) setSystemTime(start + 96 * 60 * 60 * 1000);
      for (const update of newestFirst ? [reAdd, remove, remove] : [remove, reAdd]) {
        await bot.handleUpdate(update);
      }
      expect(await repository.getVibeScore("-1001", String(messageId))).toBe(expiresAgain ? -2 : -1);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({ negativeReactionCount: 2, chargedNegativeReactionCount: expiresAgain ? 2 : 1,
          lastUpdateId: messageId + 4 });
      expect(await database.prepare(
        "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
      ).bind(String(actorId)).first<string>("charged_at"))
        .toBe(expiresAgain ? new Date(start + 96 * 60 * 60 * 1000).toISOString() : anchor);
    } finally {
      setSystemTime();
      telegram.restore();
    }
  });

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
    await legacyDb.prepare(`UPDATE reaction_vibe_states
      SET last_update_date = 100, last_update_id = 100 WHERE message_id = 1`).run();

    await applyMigration(legacyDb, "0007_negative_reaction_limits.sql");
    const originalAnchor = await legacyDb.prepare(
      "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = 'legacy-actor'",
    ).first<string>("charged_at");
    await applyMigration(legacyDb, "0008_negative_reaction_charge_origins.sql");
    const legacyRepo = createD1CommunityBotRepository(legacyDb);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(-2);
    expect((await legacyRepo.getReactionVibeState("-1001", 1, "legacy-actor"))
      .chargedNegativeReactionCount).toBe(2);
    for (const [messageId, actorId] of [[2, "legacy-actor"], [3, "legacy-actor"], [4, "__reaction_count__"]] as const) {
      expect((await legacyRepo.getReactionVibeState("-1001", messageId, actorId))
        .chargedNegativeReactionCount).toBe(0);
    }

    const historicalRemoval = limitedReactionInput("legacy-actor", 1);
    historicalRemoval.entry.idempotencyKey = "legacy-historical-removal";
    historicalRemoval.state.lastUpdateDate = 99;
    historicalRemoval.state.lastUpdateId = 99;
    historicalRemoval.state.negativeReactionCount = 0;
    historicalRemoval.requestNegativeCharge = false;
    historicalRemoval.writeState = false;
    await legacyRepo.applyLimitedReactionVibe(historicalRemoval);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(-2);

    const refund = limitedReactionInput("legacy-actor", 1);
    refund.entry.idempotencyKey = "legacy-refund";
    refund.entry.delta = 0;
    refund.state.negativeReactionCount = 0;
    refund.requestNegativeCharge = false;
    refund.oldNegativeReactionCount = 2;
    refund.state.lastUpdateId = 101;
    refund.state.lastUpdateDate = 101;
    await legacyRepo.applyLimitedReactionVibe(refund);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(0);
    expect((await legacyRepo.applyLimitedReactionVibe(limitedReactionInput("legacy-actor", 5)))
      .negativeChargeApplied).toBe(false);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(0);
    expect(await legacyDb.prepare(
      "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = 'legacy-actor'",
    ).first<string>("charged_at")).toBe(originalAnchor);
  });

  test("rolls back charge refunds with a failed snapshot write and safely retries", async () => {
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(6400, 6400, 6400));
      await bot.handleUpdate(negativeReactionUpdate(6401, 6400, { actorId: 64 }));
      await database.prepare(`CREATE TRIGGER fail_refund_snapshot
        BEFORE INSERT ON reaction_vibe_states WHEN NEW.actor_id = '64'
        BEGIN SELECT RAISE(ABORT, 'test refund write failure'); END`).run();
      const removal = negativeReactionUpdate(6402, 6400, { actorId: 64, remove: true });
      try {
        await expect(bot.handleUpdate(removal)).rejects.toThrow();
        expect(await repository.getVibeScore("-1001", "6400")).toBe(-1);
        expect(await repository.getReactionVibeState("-1001", 6400, "64"))
          .toMatchObject({ chargedNegativeReactionCount: 1, lastUpdateId: 6401 });
      } finally {
        await database.prepare("DROP TRIGGER fail_refund_snapshot").run();
      }
      await bot.handleUpdate(removal);
      expect(await repository.getVibeScore("-1001", "6400")).toBe(0);
      expect((await repository.getReactionVibeState("-1001", 6400, "64")))
        .toMatchObject({ chargedNegativeReactionCount: 0, negativeReactionCount: 0 });
    } finally {
      telegram.restore();
    }
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

  test("uses a rolling forty-eight-hour D1 allowance without extending it for denied reactions", async () => {
    const start = Date.parse("2026-10-10T12:00:00.000Z");
    setSystemTime(start);
    try {
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 1),
      )).negativeChargeApplied).toBe(true);
      setSystemTime(start + 24 * 60 * 60 * 1000);
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 2),
      )).negativeChargeApplied).toBe(false);
      setSystemTime(start + 48 * 60 * 60 * 1000 - 1);
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 3),
      )).negativeChargeApplied).toBe(false);
      setSystemTime(start + 48 * 60 * 60 * 1000);
      expect((await repository.applyLimitedReactionVibe(
        limitedReactionInput("rolling-window", 4),
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
      lastUpdateDate: messageId, lastUpdateId: messageId,
    },
    oldNegativeReactionCount: 0,
    requestNegativeCharge: true,
    writeState: true,
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
  options: { remove?: boolean; actorId?: number; chatId?: number;
    oldEmojis?: Array<"👎" | "💩" | "👍">; newEmojis?: Array<"👎" | "💩" | "👍"> } = {},
): Update {
  const reaction = { type: "emoji" as const, emoji: "👎" as const };
  return {
    update_id: updateId,
    message_reaction: {
      chat: { id: options.chatId ?? -1001, type: "supergroup", title: "Test" },
      message_id: messageId, date: updateId,
      user: { id: options.actorId ?? 20, is_bot: false, first_name: "Actor" },
      old_reaction: options.oldEmojis?.map(emoji => ({ type: "emoji" as const, emoji })) ??
        (options.remove ? [reaction] : []),
      new_reaction: options.newEmojis?.map(emoji => ({ type: "emoji" as const, emoji })) ??
        (options.remove ? [] : [reaction]),
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
