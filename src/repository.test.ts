import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import type { Chat, Update } from "grammy/types";
import { Miniflare } from "miniflare";
import { createCommunityBot } from "./bot";
import {
  type ChannelJoinJob,
  type ChannelProfileJob,
  createChannelJoinMonitor,
} from "./channel-join-monitor";
import {
  createQueueBatch,
  createQueueMock,
  createTestEnv,
  installTelegramFetchMock,
  type QueuedMessage,
} from "./__tests__/helpers";
import worker from "./index";
import { createD1CommunityBotRepository } from "./repository";
import type {
  CommunityBotRepository,
  LimitedReactionVibeInput,
  ModerationActionInput,
  ReactionVibeStateInput,
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
  test.each([
    { actorId: 70, newestFirst: false, terminalEmoji: null },
    { actorId: 71, newestFirst: true, terminalEmoji: null },
    { actorId: 72, newestFirst: false, terminalEmoji: "👍" },
    { actorId: 73, newestFirst: true, terminalEmoji: "👍" },
    { actorId: 74, newestFirst: false, terminalEmoji: "💩" },
    { actorId: 75, newestFirst: true, terminalEmoji: "💩" },
  ] as const)("charges the first negative independently of snapshot order: %j", async ({ actorId, newestFirst, terminalEmoji }) => {
    const messageId = actorId * 100;
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(messageId, messageId, messageId));
      const add = negativeReactionUpdate(messageId + 1, messageId, { actorId });
      const terminal = negativeReactionUpdate(messageId + 2, messageId, {
        actorId, oldEmojis: ["👎"], newEmojis: terminalEmoji ? [terminalEmoji] : [],
      });
      const updates = newestFirst ? [terminal, add] : [add, terminal];
      for (const update of [...updates, ...updates]) await bot.handleUpdate(update);

      expect(await repository.getVibeScore("-1001", String(messageId)))
        .toBe(terminalEmoji === "👍" ? 0 : -1);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({
          positiveReactionCount: Number(terminalEmoji === "👍"),
          negativeReactionCount: Number(terminalEmoji === "💩"),
          lastUpdateId: messageId + 2,
        });
      expect(await database.prepare(
        "SELECT COUNT(*) AS count FROM negative_reaction_limits WHERE actor_id = ? AND recipient_user_id = ?",
      ).bind(String(actorId), String(messageId)).first<number>("count")).toBe(1);
      expect(telegram.requests.filter(request => request.url.endsWith("/sendMessage") &&
        (request.body as { text: string }).text.includes("минус"))).toHaveLength(1);
      expect(telegram.requests.filter(request => request.url.endsWith("/deleteMessage"))).toHaveLength(0);
    } finally {
      telegram.restore();
    }
  });

  test.each([false, true])("bans at the permanent balance after first add/removal, newest first: %s", async newestFirst => {
    const actorId = newestFirst ? 77 : 76;
    const messageId = actorId * 100;
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(messageId, messageId, messageId));
      await repository.addVibeLedgerEntry({
        ...limitedReactionInput(String(actorId), messageId).entry,
        idempotencyKey: `seed:${messageId}`, recipientUserId: String(messageId), delta: -9,
      });
      const add = negativeReactionUpdate(messageId + 1, messageId, { actorId });
      const remove = negativeReactionUpdate(messageId + 2, messageId, { actorId, remove: true });
      const updates = newestFirst ? [remove, add] : [add, remove];
      for (const update of [...updates, ...updates]) await bot.handleUpdate(update);

      expect(await repository.getVibeScore("-1001", String(messageId))).toBe(-10);
      expect(telegram.requests.filter(request => request.url.endsWith("/banChatMember"))).toHaveLength(1);
      expect(telegram.requests.filter(request => request.url.endsWith("/deleteMessage"))).toHaveLength(0);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({ negativeReactionCount: 0, lastUpdateId: messageId + 2 });
    } finally {
      telegram.restore();
    }
  });

  test.each(["self", "bot", "unknown"] as const)("does not charge stale negative additions for %s authors", async protection => {
    const actorId = protection === "self" ? 78 : protection === "bot" ? 79 : 80;
    const messageId = actorId * 100;
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      if (protection !== "unknown") {
        const message = storedMessageUpdate(messageId, messageId, protection === "self" ? actorId : messageId);
        if (protection === "bot") message.message!.from!.is_bot = true;
        await bot.handleUpdate(message);
      }
      await bot.handleUpdate(negativeReactionUpdate(messageId + 2, messageId, { actorId, remove: true }));
      await bot.handleUpdate(negativeReactionUpdate(messageId + 1, messageId, { actorId }));
      expect(await database.prepare(
        "SELECT COUNT(*) AS count FROM vibe_ledger WHERE actor_user_id = ?",
      ).bind(String(actorId)).first<number>("count")).toBe(0);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({ negativeReactionCount: 0, lastUpdateId: messageId + 2 });
    } finally {
      telegram.restore();
    }
  });

  test("keeps positive scoring and the permanent charge across out-of-order snapshots", async () => {
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
      expect(await repository.getVibeScore("-1001", "6800")).toBe(0);
      expect(await repository.getReactionVibeState("-1001", 6800, "68"))
        .toMatchObject({ positiveReactionCount: 1, negativeReactionCount: 1,
          lastUpdateId: 6803 });
    } finally {
      telegram.restore();
    }
  });

  test("keeps the charge when removal and re-addition arrive out of order", async () => {
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(600, 600, 600));
      await bot.handleUpdate(negativeReactionUpdate(601, 600, { actorId: 60 }));
      await bot.handleUpdate(negativeReactionUpdate(603, 600, { actorId: 60 }));
      await bot.handleUpdate(negativeReactionUpdate(602, 600, { actorId: 60, remove: true }));

      expect((await repository.getReactionVibeState("-1001", 600, "60")))
        .toMatchObject({ negativeReactionCount: 1, lastUpdateId: 603 });
      expect(await database.prepare(
        "SELECT SUM(delta) AS score FROM vibe_ledger WHERE actor_user_id = '60'",
      ).first<number>("score")).toBe(-1);
    } finally {
      telegram.restore();
    }
  });

  test.each(["switch", "add"] as const)(
    "keeps one charge with newest-first remove, re-add, and %s snapshots",
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
        ).bind(String(actorId)).first<number>("score")).toBe(-1);
        expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
          .toMatchObject({ negativeReactionCount: variant === "switch" ? 1 : 2,
            lastUpdateId: messageId + 4 });
        expect(await database.prepare(
          "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
        ).bind(String(actorId)).first<string>("charged_at")).toBe(anchor);
      } finally {
        telegram.restore();
      }
    },
  );

  test("a stale removal cannot undo charges from either window", async () => {
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
      ).bind(String(actorId)).first<number>("score")).toBe(-2);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({ negativeReactionCount: 2,
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
  ])("keeps permanent charges across partial removal and re-addition: %j", async ({ newestFirst, expiresAgain, actorId }) => {
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
      expect(await repository.getVibeScore("-1001", String(messageId))).toBe(expiresAgain ? -3 : -2);
      expect(await repository.getReactionVibeState("-1001", messageId, String(actorId)))
        .toMatchObject({ negativeReactionCount: 2, lastUpdateId: messageId + 4 });
      expect(await database.prepare(
        "SELECT charged_at FROM negative_reaction_limits WHERE actor_id = ?",
      ).bind(String(actorId)).first<string>("charged_at"))
        .toBe(expiresAgain ? new Date(start + 96 * 60 * 60 * 1000).toISOString() : anchor);
    } finally {
      setSystemTime();
      telegram.restore();
    }
  });

  test("preserves legacy scores, active reactions, and pair windows while removing refund metadata", async () => {
    const legacyDb = (await miniflare.getD1Database("LEGACY")) as unknown as D1Database;
    const migrations = Array.from(new Bun.Glob("*.sql").scanSync("drizzle/migrations")).sort();
    for (const migration of migrations.filter(name => name < "0007_negative_reaction_limits.sql")) {
      await applyMigration(legacyDb, migration);
    }
    await legacyDb.prepare(
      "INSERT INTO telegram_users (id, display_name, is_bot) VALUES ('10', 'Author', 0)",
    ).run();
    await legacyDb.prepare(`INSERT INTO reaction_vibe_states (
      chat_id, message_id, actor_id, recipient_user_id,
      positive_reaction_count, poop_reaction_count, last_update_date, last_update_id, updated_at
    ) VALUES ('-1001', 1, 'legacy-actor', '10', 0, 2, 100, 100, ?)`)
      .bind(new Date().toISOString()).run();
    const oldCharge = limitedReactionInput("legacy-actor", 1).entry;
    await createD1CommunityBotRepository(legacyDb).addVibeLedgerEntry({ ...oldCharge, delta: -2 });
    await applyMigration(legacyDb, "0007_negative_reaction_limits.sql");
    await applyMigration(legacyDb, "0008_negative_reaction_charge_origins.sql");
    const originalLimit = await legacyDb.prepare(
      "SELECT * FROM negative_reaction_limits WHERE actor_id = 'legacy-actor'",
    ).first<Record<string, unknown>>();
    const originalState = await legacyDb.prepare("SELECT * FROM reaction_vibe_states").first<Record<string, unknown>>();
    expect(await legacyDb.prepare("SELECT SUM(amount) AS amount FROM negative_reaction_charges")
      .first<number>("amount")).toBe(2);

    await applyMigration(legacyDb, "0009_permanent_negative_reactions.sql");
    expect(await legacyDb.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'negative_reaction_charges'",
    ).first()).toBeNull();
    expect(await legacyDb.prepare("SELECT * FROM reaction_vibe_states").first<Record<string, unknown>>()).toEqual(originalState);
    const legacyRepo = createD1CommunityBotRepository(legacyDb);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(-2);

    const removal = limitedReactionInput("legacy-actor", 1);
    removal.entry.idempotencyKey = "legacy-removal";
    removal.state.negativeReactionCount = 0;
    removal.requestNegativeCharge = false;
    removal.state.lastUpdateId = 101;
    removal.state.lastUpdateDate = 101;
    await legacyRepo.applyLimitedReactionVibe(removal);
    expect((await legacyRepo.applyLimitedReactionVibe(limitedReactionInput("legacy-actor", 5)))
      .negativeChargeApplied).toBe(false);
    expect(await legacyRepo.getVibeScore("-1001", "10")).toBe(-2);
    expect(await legacyDb.prepare(
      "SELECT * FROM negative_reaction_limits WHERE actor_id = 'legacy-actor'",
    ).first<Record<string, unknown>>()).toEqual(originalLimit);
  });

  test("keeps the charge through a failed removal snapshot and safely retries", async () => {
    const telegram = installTelegramFetchMock();
    const bot = createCommunityBot(createTestEnv(), { repository, apiFetch: telegram.fetch });
    try {
      await bot.handleUpdate(storedMessageUpdate(6400, 6400, 6400));
      await bot.handleUpdate(negativeReactionUpdate(6401, 6400, { actorId: 64 }));
      await database.prepare(`CREATE TRIGGER fail_removal_snapshot
        BEFORE INSERT ON reaction_vibe_states WHEN NEW.actor_id = '64'
        BEGIN SELECT RAISE(ABORT, 'test removal write failure'); END`).run();
      const removal = negativeReactionUpdate(6402, 6400, { actorId: 64, remove: true });
      try {
        await expect(bot.handleUpdate(removal)).rejects.toThrow();
        expect(await repository.getVibeScore("-1001", "6400")).toBe(-1);
        expect(await repository.getReactionVibeState("-1001", 6400, "64"))
          .toMatchObject({ lastUpdateId: 6401 });
      } finally {
        await database.prepare("DROP TRIGGER fail_removal_snapshot").run();
      }
      await bot.handleUpdate(removal);
      expect(await repository.getVibeScore("-1001", "6400")).toBe(-1);
      expect((await repository.getReactionVibeState("-1001", 6400, "64")))
        .toMatchObject({ negativeReactionCount: 0 });
    } finally {
      telegram.restore();
    }
  });

  test("limits concurrent real bot updates across messages and ignores repeated negatives", async () => {
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
      expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
      await bot.handleUpdate(negativeReactionUpdate(500, 100));
      expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
      expect(telegram.requests.filter(request => request.url.endsWith("/sendMessage"))).toHaveLength(1);

      // Each actor, recipient, and chat has an independent allowance.
      await bot.handleUpdate(negativeReactionUpdate(501, 100, { actorId: 21 }));
      await bot.handleUpdate(storedMessageUpdate(502, 103, 11));
      await bot.handleUpdate(negativeReactionUpdate(503, 103));
      await bot.handleUpdate(storedMessageUpdate(504, 104, 10, -1002));
      await bot.handleUpdate(negativeReactionUpdate(505, 104, { chatId: -1002 }));
      expect(await repository.getVibeScore("-1001", "10")).toBe(-2);
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
    expect(await repository.getReactionVibeState(
      input.state.chatId, input.state.messageId, input.state.actorId,
    )).toMatchObject({ negativeReactionCount: 1, lastUpdateId: 1 });
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

describe("D1 channel join monitor", () => {
  test("bans farm profiles as soon as they join", async () => {
    const channelId = -1101;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    const farm: Profile[] = [
      { first_name: "Annett", last_name: "Massey", username: "lozmn_egfrb932" },
      { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      { first_name: "Mary2.6293,991,0601", last_name: "Beard", username: "gqnvxcimqh304", is_premium: true },
      { first_name: "Vicenta", last_name: "Arnold", username: "ArnolVicen453" },
      { first_name: "Graciela", last_name: "Townsend", username: "Towns_Graci936" },
      { first_name: "Antonina", last_name: "Klimanova", username: "antoninaklimanovayp" },
      { first_name: "Antonina", last_name: "Klimanova", username: "antonina_klimanovayp" },
      { first_name: "Hye", last_name: "Brownshaw", username: "hbrown_904", is_premium: true },
      { first_name: "Kaylee", last_name: "O'Gates", username: "kaylog_904", is_premium: true },
      { first_name: "राहुल", last_name: "शर्मा" },
      { first_name: "محمد", last_name: "علی" },
      { first_name: "王伟" },
    ];
    const people: Profile[] = [
      { first_name: "Merle", last_name: "Logan", username: "merlel_904" },
      { first_name: "Konstantin", last_name: "Ivanov", username: "konstantin123" },
      { first_name: "John", last_name: "Smith", username: "johnsmith123", is_premium: true },
      { first_name: "Greta", last_name: "Woods", username: "gretaw_1234", is_premium: true },
      { first_name: "Иван", last_name: "Петров", username: "ivan_petrov", is_premium: true },
      { first_name: "Ivan", last_name: "Petrov", username: "ivan_petrov_dev" },
      { first_name: "Anna", last_name: "Smith", username: "annasmith_ru" },
      { first_name: "Արմեն", last_name: "Սարգսյան" },
      { first_name: "Anna", is_premium: true },
    ];
    try {
      for (const [index, profile] of [...farm, ...people].entries()) {
        await monitor.join({ userId: 1_101_001 + index, date: 1000 + index * 10, profile });
      }
      await monitor.processJoins();

      expect(bannedUserIds(telegram.requests)).toEqual(farm.map((_, index) => 1_101_001 + index));
      expect(await channelJoinOutcomes(channelId)).toEqual({ allowed: people.length, banned: farm.length });
    } finally {
      telegram.restore();
    }
  });

  test("checks the profile of other Premium subscribers with three-digit usernames", async () => {
    const channelId = -1102;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, withProfiles(telegram.fetch, {
      1_102_001: { photo: PROFILE_PHOTO },
      1_102_002: { photo: PROFILE_PHOTO, bio: "Пишу про еду" },
      1_102_003: { photo: PROFILE_PHOTO, emoji_status_custom_emoji_id: "5368324170671202286" },
      1_102_004: { photo: PROFILE_PHOTO, personal_chat: { id: -1009, type: "channel", title: "Мой канал" } },
      1_102_005: { photo: PROFILE_PHOTO, first_profile_audio: { file_id: "a", file_unique_id: "au", duration: 180 } },
      1_102_006: {},
    }));
    const subscribers: Profile[] = [
      { first_name: "Сыр", last_name: "Скуфов", username: "syrskufov_904", is_premium: true },
      { first_name: "Al", last_name: "Bundy", username: "albund_904", is_premium: true },
      { first_name: "Егор", last_name: "Яловой", username: "Avirexxx_013", is_premium: true },
      { first_name: "Алекс", username: "r2d002", is_premium: true },
      { first_name: "Лена", username: "lena_905", is_premium: true },
      { first_name: "Оля", username: "olya_906", is_premium: true },
      // Telegram rejects the profile lookup of this subscriber.
      { first_name: "Маша", username: "masha_907", is_premium: true },
    ];
    try {
      for (const [index, profile] of subscribers.entries()) {
        await monitor.join({ userId: 1_102_001 + index, date: 1000 + index * 10, profile });
      }
      await monitor.processJoins();

      expect(bannedUserIds(telegram.requests)).toEqual([1_102_001]);
      expect(await channelJoinOutcomes(channelId)).toEqual({ allowed: 6, banned: 1 });
      expect((await storedJoins(channelId)).filter(join => join.has_photo === null)).toEqual([{
        user_id: "1102007", is_premium: 1, language_code: null, outcome: "allowed",
        has_bio: null, has_personal_chat: null, has_emoji_status: null, has_profile_audio: null, has_photo: null,
      }]);
      expect(monitor.profileQueue).toEqual([]);
    } finally {
      telegram.restore();
    }
  });

  test("stores the profile, Premium flag, and language of every subscriber", async () => {
    const channelId = -1103;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, withProfiles(telegram.fetch, {
      1_103_001: { photo: PROFILE_PHOTO },
      1_103_002: { photo: PROFILE_PHOTO, bio: "Пишу код" },
    }));
    try {
      await monitor.join({
        userId: 1_103_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });
      await monitor.join({ userId: 1_103_002, date: 1001, performerOnly: { is_premium: true, language_code: "en" } });
      await monitor.join({ userId: 1_103_003, date: 1002 });
      await monitor.processJoins();
      await monitor.processProfiles();

      const noProfile = { has_bio: null, has_personal_chat: null, has_emoji_status: null, has_profile_audio: null, has_photo: null };
      expect(await storedJoins(channelId)).toEqual([
        {
          user_id: "1103001", is_premium: 0, language_code: null, outcome: "banned",
          has_bio: 0, has_personal_chat: 0, has_emoji_status: 0, has_profile_audio: 0, has_photo: 1,
        },
        {
          user_id: "1103002", is_premium: 1, language_code: "en", outcome: "allowed",
          has_bio: 1, has_personal_chat: 0, has_emoji_status: 0, has_profile_audio: 0, has_photo: 1,
        },
        { user_id: "1103003", is_premium: 0, language_code: null, outcome: "allowed", ...noProfile },
      ]);
      expect(monitor.profileQueue).toEqual([]);
    } finally {
      telegram.restore();
    }
  });

  test("never bans owners", async () => {
    const channelId = -1104;
    const ownerId = 1_104_001;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch, { ownerUserIds: String(ownerId) });
    try {
      await monitor.join({
        userId: ownerId, date: 1000,
        profile: { first_name: "Annett", last_name: "Massey", username: "lozmn_egfrb932" },
      });
      await monitor.processJoins();

      expect(telegram.requests).toEqual([]);
      expect(await channelJoinOutcomes(channelId)).toEqual({ allowed: 1 });
    } finally {
      telegram.restore();
    }
  });

  test("keeps a rejected ban as ban_failed and finishes the job", async () => {
    const channelId = -1105;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, failingCalls("banChatMember", telegram.fetch, () => ({
      error_code: 400, description: "Bad Request: PARTICIPANT_ID_INVALID",
    })));
    try {
      await monitor.join({
        userId: 1_105_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });

      expect(await monitor.processJoins()).toStrictEqual([]);
      expect(await channelJoinOutcomes(channelId)).toEqual({ ban_failed: 1 });
    } finally {
      telegram.restore();
    }
  });

  test("retries a ban after a transient failure", async () => {
    const channelId = -1106;
    const telegram = installTelegramFetchMock();
    let banAttempts = 0;
    const monitor = createChannelMonitor(channelId, failingCalls("banChatMember", telegram.fetch, () => {
      banAttempts += 1;
      return banAttempts === 1 ? { error_code: 500, description: "Internal Server Error" } : null;
    }));
    try {
      await monitor.join({
        userId: 1_106_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });

      expect(await monitor.processJoins()).toStrictEqual([undefined]);
      expect(await channelJoinOutcomes(channelId)).toEqual({ ban_failed: 1 });
      expect(await monitor.processJoins()).toStrictEqual([]);
      expect(banAttempts).toBe(2);
      expect(await channelJoinOutcomes(channelId)).toEqual({ banned: 1 });
    } finally {
      telegram.restore();
    }
  });

  test("waits out a short Telegram rate limit within the delivery", async () => {
    const channelId = -1107;
    const telegram = installTelegramFetchMock();
    let banAttempts = 0;
    const monitor = createChannelMonitor(channelId, failingCalls("banChatMember", telegram.fetch, () => {
      banAttempts += 1;
      return banAttempts === 1 ? rateLimitError(1) : null;
    }));
    try {
      await monitor.join({
        userId: 1_107_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });
      await monitor.join({
        userId: 1_107_002, date: 1000,
        profile: { first_name: "Annett", last_name: "Massey", username: "lozmn_egfrb932" },
      });

      expect(await monitor.processJoins()).toStrictEqual([]);
      expect(banAttempts).toBe(3);
      expect(await channelJoinOutcomes(channelId)).toEqual({ banned: 2 });
    } finally {
      telegram.restore();
    }
  });

  test("returns the remaining bans to the queue for a long Telegram rate limit", async () => {
    const channelId = -1122;
    const telegram = installTelegramFetchMock();
    let banAttempts = 0;
    const monitor = createChannelMonitor(channelId, failingCalls("banChatMember", telegram.fetch, () => {
      banAttempts += 1;
      return rateLimitError(120);
    }));
    try {
      await monitor.join({
        userId: 1_122_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });
      await monitor.join({
        userId: 1_122_002, date: 1000,
        profile: { first_name: "Annett", last_name: "Massey", username: "lozmn_egfrb932" },
      });

      expect(await monitor.processJoins()).toStrictEqual([{ delaySeconds: 120 }, { delaySeconds: 120 }]);
      expect(banAttempts).toBe(1);
      expect(await channelJoinOutcomes(channelId)).toEqual({ ban_failed: 2 });
    } finally {
      telegram.restore();
    }
  });

  test("returns the remaining profile lookups to the queue for a long Telegram rate limit", async () => {
    const channelId = -1125;
    const telegram = installTelegramFetchMock();
    let lookupAttempts = 0;
    const monitor = createChannelMonitor(channelId, failingCalls("getChat", telegram.fetch, () => {
      lookupAttempts += 1;
      return rateLimitError(120);
    }));
    try {
      await monitor.seed(3, 1000);
      await monitor.processJoins();

      expect(await monitor.processProfiles()).toStrictEqual([
        { delaySeconds: 120 }, { delaySeconds: 120 }, { delaySeconds: 120 },
      ]);
      expect(lookupAttempts).toBe(1);
    } finally {
      telegram.restore();
    }
  });

  test("retries a failed profile lookup and continues with the next one", async () => {
    const channelId = -1126;
    const telegram = installTelegramFetchMock();
    let lookupAttempts = 0;
    const profiles = withProfiles(telegram.fetch, { 1_126_002: { photo: PROFILE_PHOTO, bio: "Пишу код" } });
    const monitor = createChannelMonitor(channelId, failingCalls("getChat", profiles, () => {
      lookupAttempts += 1;
      return lookupAttempts === 1 ? { error_code: 500, description: "Internal Server Error" } : null;
    }));
    try {
      await monitor.join({ userId: 1_126_001, date: 1000 });
      await monitor.join({ userId: 1_126_002, date: 1001 });
      await monitor.processJoins();

      expect(await monitor.processProfiles()).toStrictEqual([undefined]);
      expect(lookupAttempts).toBe(2);
      const noProfile = { has_bio: null, has_personal_chat: null, has_emoji_status: null, has_profile_audio: null, has_photo: null };
      expect(await storedJoins(channelId)).toEqual([
        { user_id: "1126001", is_premium: 0, language_code: null, outcome: "allowed", ...noProfile },
        {
          user_id: "1126002", is_premium: 0, language_code: null, outcome: "allowed",
          has_bio: 1, has_personal_chat: 0, has_emoji_status: 0, has_profile_audio: 0, has_photo: 1,
        },
      ]);
    } finally {
      telegram.restore();
    }
  });

  test("retries the joins when their profile lookups cannot be queued", async () => {
    const channelId = -1127;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch, { failedProfileSends: 1 });
    try {
      await monitor.join({
        userId: 1_127_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });
      await monitor.join({ userId: 1_127_002, date: 1001 });

      expect(await monitor.processJoins()).toStrictEqual([undefined, undefined]);
      expect(monitor.profileQueue).toEqual([]);
      expect(await monitor.processJoins()).toStrictEqual([]);
      expect(monitor.profileQueue.map(({ message }) => message.userId)).toEqual([1_127_001, 1_127_002]);
      expect(bannedUserIds(telegram.requests)).toEqual([1_127_001]);
      expect(await channelJoinOutcomes(channelId)).toEqual({ allowed: 1, banned: 1 });
    } finally {
      telegram.restore();
    }
  });

  test("alerts the owner with the burst accounts when 50 join within 2 seconds", async () => {
    const channelId = -1108;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.seed(1, 999);
      await monitor.seed(25, 1000, 25);
      await monitor.seed(24, 1001, 24);
      // A burst alone bans nobody: this profile matches the farm only with Premium.
      await monitor.join({
        userId: 1_108_999, date: 1001,
        profile: { first_name: "Greta", last_name: "Woods", username: "gretaw_904" },
      });
      await monitor.processJoins();

      const alerts = alertRequests(telegram.requests);
      expect(alerts).toHaveLength(1);
      expect(bannedUserIds(telegram.requests)).toEqual([]);
      const firstSeedId = Math.abs(channelId) * 10_000;
      const burstUserIds = [
        ...Array.from({ length: 49 }, (_, index) => firstSeedId + 1 + index),
        1_108_999,
      ];
      const alertText = (alerts[0]!.body as { text: string }).text;
      for (const userId of burstUserIds) {
        expect(alertText).toContain(String(userId));
      }
      expect(alertText).not.toContain(String(firstSeedId));
    } finally {
      telegram.restore();
    }
  });

  test("alerts when a burst spans several queue batches", async () => {
    const channelId = -1109;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.seed(25, 1000, 25);
      await monitor.processJoins();
      await monitor.seed(25, 1001, 25);
      await monitor.processJoins();

      expect(alertRequests(telegram.requests)).toHaveLength(1);
    } finally {
      telegram.restore();
    }
  });

  test("alerts when the later second of a burst is processed first", async () => {
    const channelId = -1123;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.seed(25, 1001, 25);
      await monitor.processJoins();
      await monitor.seed(25, 1000, 25);
      await monitor.processJoins();

      expect(alertRequests(telegram.requests)).toHaveLength(1);
    } finally {
      telegram.restore();
    }
  });

  test("fits a burst alert with long names into one Telegram message", async () => {
    const channelId = -1110;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      for (let index = 0; index < 50; index += 1) {
        await monitor.join({
          userId: 1_110_000 + index, date: 1000,
          profile: { first_name: "F".repeat(64), last_name: "L".repeat(64), username: `long_subscriber_${index}` },
        });
      }
      await monitor.processJoins();

      const alerts = alertRequests(telegram.requests);
      expect(alerts).toHaveLength(1);
      const alertText = (alerts[0]!.body as { text: string }).text;
      expect(alertText.length).toBeLessThanOrEqual(4096);
      expect(alertText).toContain("1110000");
    } finally {
      telegram.restore();
    }
  });

  test("does not alert when 50 joins take longer than 2 seconds", async () => {
    const channelId = -1111;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.seed(50, 1000, 20);
      await monitor.processJoins();

      expect(telegram.requests).toEqual([]);
      expect(await countChannelJoins(channelId)).toBe(50);
    } finally {
      telegram.restore();
    }
  });

  test("alerts again only after the cooldown", async () => {
    const channelId = -1112;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      for (const firstDate of [1000, 1060, 1000 + 5 * 60]) {
        await monitor.seed(50, firstDate, 50);
        await monitor.processJoins();
      }

      expect(alertRequests(telegram.requests)).toHaveLength(2);
    } finally {
      telegram.restore();
    }
  });

  test("tries a rejected alert once per cooldown and keeps recording joins", async () => {
    const channelId = -1113;
    let alertAttempts = 0;
    const rejectingFetch = (async () => {
      alertAttempts += 1;
      return Response.json({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot can't initiate conversation with a user",
      });
    }) as unknown as typeof fetch;
    const monitor = createChannelMonitor(channelId, rejectingFetch);
    await monitor.seed(51, 1000, 51);

    expect(await monitor.processJoins()).toStrictEqual([]);
    expect(alertAttempts).toBe(1);
    expect(await countChannelJoins(channelId)).toBe(51);
  });

  test("redelivers the batch when the joins cannot be stored", async () => {
    const channelId = -1114;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.seed(49, 1000, 49);
      await monitor.join({ userId: 1_114_001, date: 1001 });
      await database.prepare(`CREATE TRIGGER fail_channel_join
        BEFORE INSERT ON channel_joins WHEN NEW.update_id = 1114001
        BEGIN SELECT RAISE(ABORT, 'test channel join write failure'); END`).run();
      try {
        await expect(monitor.processJoins()).rejects.toThrow();
      } finally {
        await database.prepare("DROP TRIGGER fail_channel_join").run();
      }
      expect(alertRequests(telegram.requests)).toHaveLength(0);
      await monitor.processJoins();

      expect(alertRequests(telegram.requests)).toHaveLength(1);
      expect(await countChannelJoins(channelId)).toBe(50);
    } finally {
      telegram.restore();
    }
  });

  test("resends the alert after a transient alert failure", async () => {
    const channelId = -1115;
    const telegram = installTelegramFetchMock();
    let alertAttempts = 0;
    const failingOnceFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      alertAttempts += 1;
      if (alertAttempts === 1) {
        return Response.json({ ok: false, error_code: 500, description: "Internal Server Error" });
      }
      return telegram.fetch(input, init);
    }) as typeof fetch;
    const monitor = createChannelMonitor(channelId, failingOnceFetch);
    try {
      await monitor.seed(49, 1000, 49);
      await monitor.join({ userId: 1_115_001, date: 1001 });

      // The joins of the burst window come back to alert again.
      expect(await monitor.processJoins()).toStrictEqual(Array(50).fill(undefined));
      expect(await monitor.processJoins()).toStrictEqual([]);
      expect(alertAttempts).toBe(2);
      expect(alertRequests(telegram.requests)).toHaveLength(1);
      expect(await countChannelJoins(channelId)).toBe(50);
    } finally {
      telegram.restore();
    }
  });

  test("routes queued channel joins through the worker", async () => {
    const channelId = -1116;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = telegram.fetch;
    try {
      await monitor.join({
        userId: 1_116_001, date: 1000,
        profile: { first_name: "Erin", last_name: "Barber", username: "zktkfncxqg547" },
      });
      await worker.queue(createQueueBatch(monitor.joinQueue.map(({ message }) => message)), monitor.env);

      expect(bannedUserIds(telegram.requests)).toEqual([1_116_001]);
      expect(await channelJoinOutcomes(channelId)).toEqual({ banned: 1 });
    } finally {
      globalThis.fetch = originalFetch;
      telegram.restore();
    }
  });

  test("routes queued profile lookups through the worker", async () => {
    const channelId = -1124;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = withProfiles(telegram.fetch, { 1_124_001: { photo: PROFILE_PHOTO, bio: "Пишу код" } });
    try {
      await monitor.join({ userId: 1_124_001, date: 1000 });
      await monitor.processJoins();
      await worker.queue(createQueueBatch(monitor.profileQueue.map(({ message }) => message)), monitor.env);

      expect(await storedJoins(channelId)).toEqual([{
        user_id: "1124001", is_premium: 0, language_code: null, outcome: "allowed",
        has_bio: 1, has_personal_chat: 0, has_emoji_status: 0, has_profile_audio: 0, has_photo: 1,
      }]);
    } finally {
      globalThis.fetch = originalFetch;
      telegram.restore();
    }
  });

  test("ignores members who leave the channel", async () => {
    const channelId = -1117;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.join({ userId: 1_117_001, date: 1000, kicked: true });

      expect(monitor.joinQueue).toEqual([]);
      expect(telegram.requests).toEqual([]);
    } finally {
      telegram.restore();
    }
  });

  test("keeps monitored channel updates away from community features", async () => {
    const channelId = -1118;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch, { allowedChatIds: `-1001,${channelId}` });
    try {
      await monitor.bot.handleUpdate(monitoredChannelPostUpdate(1_118_001, channelId, "https://example.com/claim"));
      await monitor.join({ userId: 1_118_002, date: 1000 });

      expect(telegram.requests).toEqual([]);
      expect(monitor.joinQueue).toHaveLength(1);
    } finally {
      telegram.restore();
    }
  });

  test("welcomes community members while a channel is monitored", async () => {
    const channelId = -1119;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.join({ userId: 1_119_001, date: 1000 });
      await monitor.bot.handleUpdate(chatMemberUpdate(1_119_002, COMMUNITY_CHAT, { userId: 1_119_002, date: 1000 }));

      expect(telegram.requests).toEqual([{
        url: expect.stringMatching(/\/sendMessage$/u),
        body: expect.objectContaining({ chat_id: COMMUNITY_CHAT.id }),
      }]);
      expect(monitor.joinQueue).toHaveLength(1);
    } finally {
      telegram.restore();
    }
  });

  test("keeps monitored channel updates out of update reservations", async () => {
    const channelId = -1120;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch);
    try {
      await monitor.join({ userId: 1_120_001, date: 1000 });
      await monitor.join({ userId: 1_120_001, updateId: 1_120_002, date: 1001, kicked: true });

      expect(await database.prepare(
        "SELECT COUNT(*) AS count FROM processed_updates WHERE update_id IN (1120001, 1120002)",
      ).first<number>("count")).toBe(0);
      expect(monitor.joinQueue).toHaveLength(1);
    } finally {
      telegram.restore();
    }
  });

  test("fails the update for a Telegram retry when the join cannot be queued", async () => {
    const channelId = -1128;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch, { failedJoinSends: 1 });
    try {
      await expect(monitor.join({ userId: 1_128_001, date: 1000 })).rejects.toThrow();

      expect(await database.prepare(
        "SELECT COUNT(*) AS count FROM processed_updates WHERE update_id = 1128001",
      ).first<number>("count")).toBe(0);
      expect(monitor.joinQueue).toEqual([]);
      expect(telegram.requests).toEqual([]);
    } finally {
      telegram.restore();
    }
  });

  test("drops channel joins without stalling the webhook when the join queue is missing", async () => {
    const channelId = -1121;
    const telegram = installTelegramFetchMock();
    const monitor = createChannelMonitor(channelId, telegram.fetch, { withoutJoinQueue: true });
    try {
      await monitor.join({ userId: 1_121_001, date: 1000 });

      expect(telegram.requests).toEqual([]);
      expect(await countChannelJoins(channelId)).toBe(0);
    } finally {
      telegram.restore();
    }
  });
});

const CHANNEL_ALERT_USER_ID = 7991;
const COMMUNITY_CHAT = { id: -1001, type: "supergroup", title: "Students" } as const;
const PROFILE_PHOTO = {
  small_file_id: "small", small_file_unique_id: "small-unique",
  big_file_id: "big", big_file_unique_id: "big-unique",
};

type Profile = { first_name: string; last_name?: string; username?: string; is_premium?: true };
// Fields that only the performer of the membership change carries.
type PerformerFields = { is_premium?: true; language_code?: string };
type JoinOptions = {
  userId: number;
  date: number;
  updateId?: number;
  kicked?: boolean;
  profile?: Profile;
  performerOnly?: PerformerFields;
};

// The webhook, both queue consumers, and D1 are real. Telegram is a fetch double.
function createChannelMonitor(
  channelId: number,
  apiFetch: typeof fetch,
  options: {
    allowedChatIds?: string;
    ownerUserIds?: string;
    withoutJoinQueue?: boolean;
    failedJoinSends?: number;
    failedProfileSends?: number;
  } = {},
) {
  const joinQueue = createQueueMock<ChannelJoinJob>();
  const profileQueue = createQueueMock<ChannelProfileJob>();
  const env = createTestEnv(options.allowedChatIds ?? "-1001", {
    DB: database,
    MONITORED_CHANNEL_IDS: String(channelId),
    CHANNEL_ALERT_USER_ID: String(CHANNEL_ALERT_USER_ID),
    OWNER_USER_IDS: options.ownerUserIds ?? "",
    CHANNEL_JOIN_QUEUE: options.withoutJoinQueue
      ? undefined
      : failingFirstSends(joinQueue.queue, options.failedJoinSends ?? 0),
    CHANNEL_PROFILE_QUEUE: failingFirstSends(profileQueue.queue, options.failedProfileSends ?? 0),
  });
  const bot = createCommunityBot(env, { repository, apiFetch });
  const monitor = createChannelJoinMonitor(env, { apiFetch, profileLookupPauseMs: 0 });
  let seeded = 0;

  async function join(joinOptions: JoinOptions) {
    await bot.handleUpdate(channelMemberUpdate(joinOptions.updateId ?? joinOptions.userId, { channelId, ...joinOptions }));
  }

  return {
    bot,
    env,
    joinQueue: joinQueue.messages,
    profileQueue: profileQueue.messages,
    join,
    // Seeds ordinary subscribers. The default pace stays below the join burst limit.
    async seed(count: number, firstDate: number, joinsPerSecond = 5) {
      for (let offset = 0; offset < count; offset += 1) {
        const userId = Math.abs(channelId) * 10_000 + seeded;
        seeded += 1;
        await join({ userId, date: firstDate + Math.floor(offset / joinsPerSecond) });
      }
    },
    processJoins: () => deliver(joinQueue.messages, messages => monitor.processJoins(messages)),
    processProfiles: () => deliver(profileQueue.messages, messages => monitor.processProfiles(messages)),
  };
}

// Delivers the queued messages as one batch. A retried message or a failed batch
// goes back to the queue, as with Cloudflare Queues. Returns the retry options.
async function deliver<Body>(
  queued: Array<QueuedMessage<Body>>,
  process: (messages: readonly Message<Body>[]) => Promise<void>,
): Promise<Array<QueueRetryOptions | undefined>> {
  const bodies = queued.splice(0).map(({ message }) => message);
  const retries: Array<QueueRetryOptions | undefined> = [];
  const batch = createQueueBatch(bodies, (body, options) => {
    retries.push(options);
    queued.push({ message: body, options });
  });
  try {
    await process(batch.messages);
  } catch (error) {
    queued.unshift(...bodies.map(message => ({ message })));
    throw error;
  }
  return retries;
}

// Rejects the first sends to the queue, as a transient Cloudflare Queues failure does.
function failingFirstSends<Body>(queue: Queue<Body>, failures: number): Queue<Body> {
  let remaining = failures;
  const failSend = () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("test queue send failure");
    }
  };
  return {
    ...queue,
    async send(message, options) {
      failSend();
      return queue.send(message, options);
    },
    async sendBatch(messages, options) {
      failSend();
      return queue.sendBatch(messages, options);
    },
  };
}

// Answers getChat with the given profiles and rejects unknown users.
function withProfiles(apiFetch: typeof fetch, profiles: Record<number, object>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/getChat")) {
      return apiFetch(input, init);
    }

    const chatId = (JSON.parse(String(init?.body)) as { chat_id: number }).chat_id;
    const profile = profiles[chatId];
    return profile
      ? Response.json({ ok: true, result: { id: chatId, type: "private", first_name: "Subscriber", ...profile } })
      : Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" });
  }) as typeof fetch;
}

function rateLimitError(retryAfter: number) {
  return {
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  };
}

// Answers the method with the returned Telegram error, or passes the call on when it returns null.
function failingCalls(method: string, apiFetch: typeof fetch, callError: () => object | null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const error = String(input).endsWith(`/${method}`) ? callError() : null;
    return error ? Response.json({ ok: false, ...error }) : apiFetch(input, init);
  }) as typeof fetch;
}

async function countChannelJoins(channelId: number): Promise<number | null> {
  return database.prepare("SELECT COUNT(*) AS count FROM channel_joins WHERE chat_id = ?")
    .bind(String(channelId)).first<number>("count");
}

async function channelJoinOutcomes(channelId: number): Promise<Record<string, number>> {
  const { results } = await database.prepare(
    "SELECT outcome, COUNT(*) AS count FROM channel_joins WHERE chat_id = ? GROUP BY outcome",
  ).bind(String(channelId)).all<{ outcome: string; count: number }>();
  return Object.fromEntries(results.map(row => [row.outcome, row.count]));
}

async function storedJoins(channelId: number) {
  const { results } = await database.prepare(`SELECT user_id, is_premium, language_code, outcome,
      has_bio, has_personal_chat, has_emoji_status, has_profile_audio, has_photo
    FROM channel_joins WHERE chat_id = ? ORDER BY update_id`).bind(String(channelId)).all();
  return results;
}

function alertRequests(requests: Array<{ url: string; body: unknown }>) {
  return requests.filter(request => request.url.endsWith("/sendMessage") &&
    (request.body as { chat_id: number }).chat_id === CHANNEL_ALERT_USER_ID);
}

function bannedUserIds(requests: Array<{ url: string; body: unknown }>): number[] {
  return requests
    .filter(request => request.url.endsWith("/banChatMember"))
    .map(request => (request.body as { user_id: number }).user_id);
}

function channelMemberUpdate(updateId: number, options: JoinOptions & { channelId: number }): Update {
  return chatMemberUpdate(updateId, { id: options.channelId, type: "channel", title: "Сухарев / ЙЙ" }, options);
}

function chatMemberUpdate(updateId: number, chat: Chat, options: JoinOptions): Update {
  const user = { id: options.userId, is_bot: false, ...(options.profile ?? { first_name: "Subscriber" }) };
  const member = { status: "member" as const, user };
  return {
    update_id: updateId,
    chat_member: {
      chat,
      from: { ...user, ...options.performerOnly },
      date: options.date,
      old_chat_member: options.kicked ? member : { status: "left", user },
      new_chat_member: options.kicked ? { status: "kicked", user, until_date: 0 } : member,
    },
  };
}

function monitoredChannelPostUpdate(updateId: number, channelId: number, link: string): Update {
  const channel = { id: channelId, type: "channel" as const, title: "Сухарев / ЙЙ" };
  const text = `пост ${link}`;
  return {
    update_id: updateId,
    channel_post: {
      message_id: updateId,
      date: updateId,
      chat: channel,
      sender_chat: channel,
      text,
      entities: [{ type: "url", offset: text.indexOf(link), length: link.length }],
    },
  };
}

async function applyMigration(db: D1Database, filename: string) {
  const source = await Bun.file(`drizzle/migrations/${filename}`).text();
  for (const statement of source.split(";").filter(statement => statement.trim())) {
    await db.prepare(statement).run();
  }
}

function limitedReactionInput(actorId: string, messageId: number): LimitedReactionVibeInput & { state: ReactionVibeStateInput } {
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
