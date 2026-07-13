import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ReactionTypeEmoji, Update } from "grammy/types";
import { createCommunityBot } from "./bot";
import {
  createQueueMock,
  createTestEnv,
  InMemoryCommunityBotRepository,
  installTelegramFetchMock,
} from "./__tests__/helpers";
import { LINK_MODERATION_MESSAGE } from "./vibe";
import type { VibeNotificationDeleteJob } from "./vibe-notification-delete";

let fetchMock: ReturnType<typeof installTelegramFetchMock>;

beforeEach(() => {
  fetchMock = installTelegramFetchMock();
});

afterEach(() => {
  fetchMock.restore();
});

describe("community bot", () => {
  test("welcomes a new chat member", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(chatMemberUpdate());

    expect(fetchMock.requests).toHaveLength(1);
    const body = fetchMock.requests[0]?.body as {
      chat_id?: number;
      parse_mode?: string;
      text?: string;
    };
    const text = body.text ?? "";
    expect(body).toMatchObject({
      chat_id: -1001,
      parse_mode: "HTML",
    });
    expect(text).toContain("<blockquote expandable>");
  });

  test("mutes welcome messages until the configured time", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        WELCOME_MUTED_UNTIL: "2999-01-01T00:00:00.000Z",
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(chatMemberUpdate());

    expect(fetchMock.requests).toHaveLength(0);
    expect(repository.users.has("10")).toBe(true);
  });

  test("queues welcome messages for deletion after fifteen seconds", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const queueMock = createQueueMock<VibeNotificationDeleteJob>();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        VIBE_NOTIFICATION_DELETE_QUEUE: queueMock.queue,
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(chatMemberUpdate());

    expect(queueMock.messages).toEqual([
      {
        message: { chatId: -1001, messageId: 1 },
        options: { delaySeconds: 15 },
      },
    ]);
  });

  test("deletes welcome messages after fifteen seconds in a background task", async () => {
    jest.useFakeTimers();
    const repository = new InMemoryCommunityBotRepository();
    const scheduledTasks: Array<Promise<void>> = [];
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
      notificationDelete: {
        apiFetch: fetchMock.fetch,
        scheduleTask: (task) => scheduledTasks.push(task),
      },
    });

    try {
      await bot.handleUpdate(chatMemberUpdate());

      expect(scheduledTasks).toHaveLength(1);
      expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);

      jest.advanceTimersByTime(14_999);
      await Promise.resolve();
      expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);

      jest.advanceTimersByTime(1);
      await Promise.all(scheduledTasks);
      expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
        chat_id: -1001,
        message_id: 1,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("shows current rules with /rules", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(rulesCommandUpdate());

    expect(fetchMock.requests).toHaveLength(1);
    const body = fetchMock.requests[0]?.body as {
      chat_id?: number;
      parse_mode?: string;
      text?: string;
    };
    const text = body.text ?? "";
    expect(body).toMatchObject({
      chat_id: -1001,
      parse_mode: "HTML",
    });
    expect(text).toContain("<blockquote expandable>");
  });

  test("deletes a text message with a forbidden URL", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        author: user(10, "Кирилл", "kirill"),
        text: "посмотрите https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 120,
    });
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      chat_id: -1001,
      text: `@kirill, ${LINK_MODERATION_MESSAGE}`,
    });
  });

  test("keeps Telegram-autolinked Cyrillic dotted text", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        author: user(10, "Кирилл", "kirill"),
        text: "да не может быть.. а точку вот так могли поставить.например?",
        links: ["поставить.например"],
      }),
    );

    expect(repository.messages.size).toBe(1);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("keeps Telegram-autolinked markdown file references", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        author: user(10, "Кирилл", "kirill"),
        text: "посмотрите AGENTS.md и CLAUDE.md",
        links: ["AGENTS.md", "CLAUDE.md"],
      }),
    );

    expect(repository.messages.size).toBe(1);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("keeps forbidden links from users with at least twenty-five vibe", async () => {
    const repository = new InMemoryCommunityBotRepository();
    await repository.addVibeLedgerEntry({
      idempotencyKey: "seed:link-vibe:10",
      chatId: "-1001",
      recipientUserId: "10",
      actorUserId: null,
      delta: 25,
      source: "thanks_reply",
      reason: "test seed",
      sourceMessageId: null,
      targetMessageId: null,
    });
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        author: user(10, "Кирилл", "kirill"),
        text: "мой проект https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(1);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("still deletes forbidden links from users below twenty-five vibe", async () => {
    const repository = new InMemoryCommunityBotRepository();
    await repository.addVibeLedgerEntry({
      idempotencyKey: "seed:link-vibe:10",
      chatId: "-1001",
      recipientUserId: "10",
      actorUserId: null,
      delta: 24,
      source: "thanks_reply",
      reason: "test seed",
      sourceMessageId: null,
      targetMessageId: null,
    });
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        author: user(10, "Кирилл", "kirill"),
        text: "мой проект https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: `@kirill, ${LINK_MODERATION_MESSAGE}`,
    });
  });

  test("keeps forbidden links from allowed admin usernames", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        LINK_ALLOWED_USERNAMES: "allowed_admin,owner_admin",
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(
      linkMessageUpdate({
        updateId: 21,
        messageId: 121,
        author: user(10, "Дима", "allowed_admin"),
        text: "сайт https://example.com",
        links: ["https://example.com"],
      }),
    );
    await bot.handleUpdate(
      linkMessageUpdate({
        updateId: 22,
        messageId: 122,
        author: user(20, "Админ", "owner_admin"),
        text: "материал https://example.org",
        links: ["https://example.org"],
      }),
    );

    expect(repository.messages.size).toBe(2);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("keeps forbidden links from allowed anonymous group owner bot", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        LINK_ALLOWED_USERNAMES: "groupanonymousbot",
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(
      anonymousOwnerLinkMessageUpdate({
        text: "важное https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("deletes forbidden links from anonymous group bot without allow-list", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      anonymousOwnerLinkMessageUpdate({
        text: "важное https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("deletes a hidden text_link even when the visible text has no URL", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      hiddenLinkMessageUpdate({
        text: "материал",
        url: "https://example.com/course",
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("deletes a caption with a forbidden URL", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      captionLinkMessageUpdate({
        caption: "скрин https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("deletes a message that mixes allowed and forbidden links", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        text: "repo https://github.com/openai/codex и сайт https://example.com",
        links: ["https://github.com/openai/codex", "https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("keeps allowed GitHub, YouTube, Instagram, and main channel Telegram link messages", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        text:
          "repo https://github.com/openai/codex mirror github.com/openai/codex gist https://gist.github.com/user/id video https://youtu.be/dQw4w9WgXcQ music https://music.youtube.com/watch?v=dQw4w9WgXcQ insta https://www.instagram.com/p/C0ffeeCode/ пост https://t.me/sukharev_ii/123",
        links: [
          "https://github.com/openai/codex",
          "github.com/openai/codex",
          "https://gist.github.com/user/id",
          "https://youtu.be/dQw4w9WgXcQ",
          "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
          "https://www.instagram.com/p/C0ffeeCode/",
          "https://t.me/sukharev_ii/123",
        ],
      }),
    );

    expect(repository.messages.size).toBe(1);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("deletes Telegram links outside the main channel", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        text:
          "чужой канал https://t.me/other_channel/123 и обманка https://t.me/sukharev_ii.evil/123",
        links: [
          "https://t.me/other_channel/123",
          "https://t.me/sukharev_ii.evil/123",
        ],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("keeps a forwarded GitHub post with a Telegram source permalink", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(forwardedGithubPostUpdate());

    expect(repository.messages.size).toBe(1);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("keeps Telegram automatic forwards from a linked channel discussion", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(linkedChannelAutomaticForwardUpdate());

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("deletes a message with a deceptive GitHub-looking host", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      linkMessageUpdate({
        text:
          "не открывайте https://github.com.evil.com/openai/codex и https://evil.com/?next=https://github.com/openai/codex",
        links: [
          "https://github.com.evil.com/openai/codex",
          "https://evil.com/?next=https://github.com/openai/codex",
        ],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("deletes an edited message with a forbidden URL", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      editedLinkMessageUpdate({
        text: "добавил https://example.com",
        links: ["https://example.com"],
      }),
    );

    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 124,
    });
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: expect.stringContaining(LINK_MODERATION_MESSAGE),
    });
  });

  test("awards the replied-to author for a thanks message", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(thanksReplyUpdate());

    expect(await repository.getVibeScore("-1001", "10")).toBe(1);
    expect(fetchMock.requests.at(-1)?.body).toMatchObject({
      text: "Кирилл, вам +1 вайб (1 вайба)",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });
  });

  test("queues positive thanks announcement for deletion after five seconds", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const queueMock = createQueueMock<VibeNotificationDeleteJob>();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        VIBE_NOTIFICATION_DELETE_QUEUE: queueMock.queue,
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(thanksReplyUpdate());

    expect(queueMock.messages).toEqual([
      {
        message: { chatId: -1001, messageId: 1 },
        options: { delaySeconds: 5 },
      },
    ]);
  });

  test("uses a background task for positive thanks announcement deletion when available", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const queueMock = createQueueMock<VibeNotificationDeleteJob>();
    const scheduledTasks: Array<Promise<void>> = [];
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        VIBE_NOTIFICATION_DELETE_QUEUE: queueMock.queue,
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
        notificationDelete: {
          apiFetch: fetchMock.fetch,
          delayMs: 0,
          scheduleTask: (task) => scheduledTasks.push(task),
        },
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(thanksReplyUpdate());

    expect(scheduledTasks).toHaveLength(1);
    expect(queueMock.messages).toEqual([]);

    await Promise.all(scheduledTasks);

    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 1,
    });
  });

  test("ignores self-thanks", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate({
      ...thanksReplyUpdate(),
      update_id: 3,
      message: {
        ...thanksReplyUpdate().message,
        from: user(10, "Кирилл"),
      },
    } as Update);

    expect(repository.ledger.size).toBe(0);
  });

  test("awards and rolls back reaction vibe", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [{ type: "emoji", emoji: "👍" }]));
    await bot.handleUpdate(reactionUpdate(4, [{ type: "emoji", emoji: "👍" }], []));

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
  });

  test("queues positive reaction announcement for deletion after five seconds", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const queueMock = createQueueMock<VibeNotificationDeleteJob>();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        ANNOUNCE_REACTIONS: "true",
        VIBE_NOTIFICATION_DELETE_QUEUE: queueMock.queue,
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [emojiReaction("👍")]));

    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: "Кирилл, вам +1 вайб (1 вайба)",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });
    expect(queueMock.messages).toEqual([
      {
        message: { chatId: -1001, messageId: 1 },
        options: { delaySeconds: 5 },
      },
    ]);
  });

  test("awards reaction vibe from actor chat", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(
      actorChatReactionUpdate(3, [], [{ type: "emoji", emoji: "🤝" }]),
    );

    expect(await repository.getVibeScore("-1001", "10")).toBe(1);
    expect(repository.ledger.get("reaction:3")?.actorUserId).toBe("chat:-1002");
  });

  test("awards and rolls back aggregate reaction count vibe", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(
      reactionCountUpdate(3, [
        { type: { type: "emoji", emoji: "🤝" }, total_count: 1 },
        { type: { type: "emoji", emoji: "🙏" }, total_count: 2 },
      ]),
    );
    await bot.handleUpdate(
      reactionCountUpdate(4, [
        { type: { type: "emoji", emoji: "🤝" }, total_count: 1 },
      ]),
    );

    expect(await repository.getVibeScore("-1001", "10")).toBe(1);
  });

  test("subtracts and rolls back poop reaction vibe", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const queueMock = createQueueMock<VibeNotificationDeleteJob>();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        ANNOUNCE_REACTIONS: "true",
        VIBE_NOTIFICATION_DELETE_QUEUE: queueMock.queue,
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [emojiReaction("💩")]));

    expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: "Кирилл, минус 1 вайб (-1 вайба)",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });
    expect(queueMock.messages).toEqual([]);

    await bot.handleUpdate(reactionUpdate(4, [emojiReaction("💩")], []));

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("subtracts and rolls back thumbs-down reaction vibe", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [emojiReaction("👎")]));

    expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: "Кирилл, минус 1 вайб (-1 вайба)",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });

    await bot.handleUpdate(reactionUpdate(4, [emojiReaction("👎")], []));

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("deletes a message after three active negative reactions", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [emojiReaction("💩")], { actorId: 20 }));
    await bot.handleUpdate(reactionUpdate(4, [], [emojiReaction("👎")], { actorId: 21 }));
    await bot.handleUpdate(reactionUpdate(5, [], [emojiReaction("👎")], { actorId: 22 }));
    await bot.handleUpdate(reactionUpdate(6, [], [emojiReaction("💩")], { actorId: 23 }));

    expect(await repository.getVibeScore("-1001", "10")).toBe(-4);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 100,
    });
  });

  test("does not ban an author after six active negative reactions above low-vibe threshold", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate({ updateId: 1, messageId: 100 }));
    await bot.handleUpdate(questionMessageUpdate({ updateId: 2, messageId: 101 }));

    for (let index = 0; index < 3; index += 1) {
      await bot.handleUpdate(
        reactionUpdate(3 + index, [], [emojiReaction("💩")], {
          actorId: 20 + index,
          messageId: 100,
        }),
      );
      await bot.handleUpdate(
        reactionUpdate(6 + index, [], [emojiReaction("💩")], {
          actorId: 30 + index,
          messageId: 101,
        }),
      );
    }

    expect(await repository.getVibeScore("-1001", "10")).toBe(-6);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("does not delete or ban protected users", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        ANNOUNCE_REACTIONS: "true",
        OWNER_USER_IDS: "10,20,30",
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [emojiReaction("💩")], { actorId: 20 }));
    await bot.handleUpdate(reactionUpdate(4, [], [emojiReaction("💩")], { actorId: 21 }));
    await bot.handleUpdate(reactionUpdate(5, [], [emojiReaction("💩")], { actorId: 22 }));

    expect(await repository.getVibeScore("-1001", "10")).toBe(-3);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("ignores self negative reactions", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [], [emojiReaction("💩")], { actorId: 10 }));

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("ignores profanity and negative reactions for channel-authored messages", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
        profanityWords: ["badword"],
      },
    );

    await bot.handleUpdate(senderChatMessageUpdate({ text: "badword" }));
    await bot.handleUpdate(
      reactionUpdate(3, [], [emojiReaction("👎")], { messageId: 200 }),
    );

    expect(repository.ledger.size).toBe(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("applies aggregate negative reaction counts to delete and low-vibe ban", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(
      reactionCountUpdate(3, [
        { type: { type: "emoji", emoji: "👎" }, total_count: 10 },
      ]),
    );

    expect(await repository.getVibeScore("-1001", "10")).toBe(-10);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text:
        "Кирилл, минус 10 вайба (-10 вайба). у вас уже -10 вайба, при -10 я запрограммирована кикать из чата 🥊",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(1);
  });

  test("keeps harmless messages that do not contain standalone profanity", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(
      questionMessageUpdate({
        updateId: 1,
        messageId: 100,
        author: user(10, "Кирилл", "kirill"),
        text: "белка",
      }),
    );

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
    expect(repository.messages.size).toBe(1);
    expect(repository.ledger.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(0);
    expect(telegramMethodRequests("sendMessage")).toHaveLength(0);
  });

  test("deletes and subtracts vibe for configured profanity words", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const queueMock = createQueueMock<VibeNotificationDeleteJob>();
    const bot = createCommunityBot(
      createTestEnv("-1001", {
        VIBE_NOTIFICATION_DELETE_QUEUE: queueMock.queue,
      }),
      {
        repository,
        apiFetch: fetchMock.fetch,
        profanityWords: ["badword"],
      },
    );

    await bot.handleUpdate(
      questionMessageUpdate({
        updateId: 1,
        messageId: 100,
        author: user(10, "Кирилл", "kirill"),
        text: "это badword",
      }),
    );

    expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
    expect(repository.messages.size).toBe(0);
    expect(repository.ledger.get("profanity:1")).toMatchObject({
      recipientUserId: "10",
      actorUserId: "10",
      delta: -1,
      source: "profanity",
      sourceMessageId: 100,
      targetMessageId: 100,
    });
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 100,
    });
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      chat_id: -1001,
      text: "@kirill, минус 1 вайб (-1 вайба): сквернословие запрещено 🐿️",
    });
    expect(queueMock.messages).toEqual([]);
  });

  test("deletes an edited message with configured profanity words", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
      profanityWords: ["badword"],
    });

    await bot.handleUpdate(
      editedProfanityMessageUpdate({ text: "добавил badword" }),
    );

    expect(await repository.getVibeScore("-1001", "10")).toBe(-1);
    expect(repository.messages.size).toBe(0);
    expect(telegramMethodRequests("deleteMessage")).toHaveLength(1);
    expect(telegramMethodRequests("deleteMessage")[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 125,
    });
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text: "Кирилл, минус 1 вайб (-1 вайба): сквернословие запрещено 🐿️",
    });
  });

  test("warns at minus five vibe from negative reactions", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { ANNOUNCE_REACTIONS: "true" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
      },
    );

    await bot.handleUpdate(questionMessageUpdate());
    for (let index = 0; index < 5; index += 1) {
      await bot.handleUpdate(
        reactionUpdate(3 + index, [], [emojiReaction("👎")], {
          actorId: 20 + index,
        }),
      );
    }

    expect(await repository.getVibeScore("-1001", "10")).toBe(-5);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text:
        "Кирилл, минус 1 вайб (-5 вайба). у вас уже -5 вайба, при -10 я запрограммирована кикать из чата 🥊",
    });
  });

  test("warns at minus five vibe from profanity", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
      profanityWords: ["badword"],
    });

    for (let index = 0; index < 5; index += 1) {
      await bot.handleUpdate(
        questionMessageUpdate({
          updateId: index + 1,
          messageId: 100 + index,
          text: `badword ${index}`,
        }),
      );
    }

    expect(await repository.getVibeScore("-1001", "10")).toBe(-5);
    expect(telegramMethodRequests("sendMessage").at(-1)?.body).toMatchObject({
      text:
        "Кирилл, минус 1 вайб (-5 вайба): сквернословие запрещено 🐿️ у вас уже -5 вайба, при -10 я запрограммирована кикать из чата 🥊",
    });
  });

  test("permanently bans an author at minus ten vibe from profanity", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
      profanityWords: ["badword"],
    });

    for (let index = 0; index < 10; index += 1) {
      await bot.handleUpdate(
        questionMessageUpdate({
          updateId: index + 1,
          messageId: 100 + index,
          text: `badword ${index}`,
        }),
      );
    }

    expect(await repository.getVibeScore("-1001", "10")).toBe(-10);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(1);
    expect(telegramMethodRequests("banChatMember")[0]?.body).toMatchObject({
      chat_id: -1001,
      user_id: 10,
    });
  });

  test("does not ban protected users for profanity", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(
      createTestEnv("-1001", { OWNER_USER_IDS: "10,20,30" }),
      {
        repository,
        apiFetch: fetchMock.fetch,
        profanityWords: ["badword"],
      },
    );

    for (let index = 0; index < 10; index += 1) {
      await bot.handleUpdate(
        questionMessageUpdate({
          updateId: index + 1,
          messageId: 100 + index,
          text: `badword ${index}`,
        }),
      );
    }

    expect(await repository.getVibeScore("-1001", "10")).toBe(-10);
    expect(telegramMethodRequests("banChatMember")).toHaveLength(0);
  });

  test("retries overlapping reaction updates for the same actor and message", async () => {
    const repository = new PausingReactionStateRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });
    const addReaction = reactionUpdate(3, [], [{ type: "emoji", emoji: "👍" }]);
    const removeReaction = reactionUpdate(4, [{ type: "emoji", emoji: "👍" }], []);

    await bot.handleUpdate(questionMessageUpdate());

    const addPromise = bot.handleUpdate(addReaction);
    await repository.waitForPausedStateWrite();

    await expect(bot.handleUpdate(removeReaction)).rejects.toThrow(
      "Reaction award processing is already reserved",
    );
    expect(repository.processedUpdates.has(removeReaction.update_id)).toBe(false);

    repository.resumeStateWrite();
    await addPromise;
    expect(await repository.getVibeScore("-1001", "10")).toBe(1);

    await bot.handleUpdate(removeReaction);

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
  });

  test("does not subtract reaction vibe when the positive award was never recorded", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(reactionUpdate(3, [{ type: "emoji", emoji: "👍" }], []));

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
    expect(repository.ledger.size).toBe(0);
  });

  test("repairs reaction award state when retry follows a partial state failure", async () => {
    const repository = new FailingReactionStateOnceRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });
    const addReaction = reactionUpdate(3, [], [{ type: "emoji", emoji: "👍" }]);

    await bot.handleUpdate(questionMessageUpdate());
    await expect(bot.handleUpdate(addReaction)).rejects.toThrow("temporary D1 failure");
    expect(await repository.getVibeScore("-1001", "10")).toBe(1);
    expect(
      (await repository.getReactionVibeState("-1001", 100, "20")).positiveReactionCount,
    ).toBe(0);

    await bot.handleUpdate(addReaction);
    await bot.handleUpdate(reactionUpdate(4, [{ type: "emoji", emoji: "👍" }], []));

    expect(await repository.getVibeScore("-1001", "10")).toBe(0);
  });

  test("deduplicates repeated updates", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });
    const update = thanksReplyUpdate();

    await bot.handleUpdate(update);
    await bot.handleUpdate(update);

    expect(repository.ledger.size).toBe(1);
  });

  test("deduplicates concurrent deliveries before visible side effects", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });
    const update = chatMemberUpdate();

    const deliveries = await Promise.allSettled([
      bot.handleUpdate(update),
      bot.handleUpdate(update),
    ]);

    expect(deliveries.filter((delivery) => delivery.status === "fulfilled")).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.status === "rejected")).toHaveLength(1);
    expect(fetchMock.requests).toHaveLength(1);
    expect(repository.processedUpdates.has(update.update_id)).toBe(true);

    await bot.handleUpdate(update);

    expect(fetchMock.requests).toHaveLength(1);
  });

  test("does not acknowledge an overlapping duplicate when the first delivery can fail", async () => {
    const repository = new PausingThenFailingChatRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });
    const update = chatMemberUpdate();

    const firstDelivery = bot.handleUpdate(update);
    await repository.waitForPausedChatWrite();

    await expect(bot.handleUpdate(update)).rejects.toThrow(
      "Update processing is already reserved",
    );
    expect(repository.processedUpdates.has(update.update_id)).toBe(false);

    repository.resumeChatWrite();
    await expect(firstDelivery).rejects.toThrow("temporary D1 failure");
    expect(repository.processedUpdates.has(update.update_id)).toBe(false);

    await bot.handleUpdate(update);

    expect(repository.processedUpdates.has(update.update_id)).toBe(true);
    expect(fetchMock.requests).toHaveLength(1);
  });

  test("does not mark failed updates as processed so Telegram retries can recover", async () => {
    const repository = new FailingStoreOnceRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });
    const update = questionMessageUpdate();

    await expect(bot.handleUpdate(update)).rejects.toThrow("temporary D1 failure");
    expect(repository.processedUpdates.has(update.update_id)).toBe(false);
    expect(repository.processingUpdates.has(update.update_id)).toBe(false);
    expect(repository.messages.size).toBe(0);

    await bot.handleUpdate(update);

    expect(repository.processedUpdates.has(update.update_id)).toBe(true);
    expect(repository.messages.size).toBe(1);
  });

  test("ignores non-allowed chats except /chatid", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv("-1002"), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(chatIdCommandUpdate());

    expect(repository.messages.size).toBe(0);
    expect(fetchMock.requests).toHaveLength(1);
    expect(fetchMock.requests[0]?.body).toMatchObject({
      text: "chat id: -1001",
    });
  });

  test("shows vibe score and top", async () => {
    const repository = new InMemoryCommunityBotRepository();
    const bot = createCommunityBot(createTestEnv(), {
      repository,
      apiFetch: fetchMock.fetch,
    });

    await bot.handleUpdate(questionMessageUpdate());
    await bot.handleUpdate(thanksReplyUpdate());
    await bot.handleUpdate(vibeCommandUpdate());
    await bot.handleUpdate(vibeTopCommandUpdate());

    expect(fetchMock.requests.at(-2)?.body).toMatchObject({
      text: "Дима, у вас 0 вайба.",
    });
    expect(fetchMock.requests.at(-1)?.body).toMatchObject({
      text: expect.stringContaining("1. Кирилл — 1 вайба"),
    });
  });
});

function chatMemberUpdate(): Update {
  return {
    update_id: 1,
    chat_member: {
      chat: chat(),
      from: user(1, "Админ"),
      date: 1,
      old_chat_member: {
        status: "left",
        user: user(10, "Кирилл"),
      },
      new_chat_member: {
        status: "member",
        user: user(10, "Кирилл"),
      },
    },
  } as Update;
}

function questionMessageUpdate(
  options: {
    updateId?: number;
    messageId?: number;
    author?: ReturnType<typeof user>;
    text?: string;
  } = {},
): Update {
  const messageId = options.messageId ?? 100;
  return {
    update_id: options.updateId ?? 1,
    message: {
      message_id: messageId,
      date: 1,
      chat: chat(),
      from: options.author ?? user(10, "Кирилл"),
      text: options.text ?? "Как лучше задеплоить воркер?",
    },
  } as Update;
}

function senderChatMessageUpdate(options: { text?: string } = {}): Update {
  return {
    update_id: 2,
    message: {
      message_id: 200,
      date: 1,
      chat: chat(),
      sender_chat: { id: -1003, type: "channel", title: "Сухарев / ЙЙ" },
      text: options.text ?? "пост канала",
    },
  } as Update;
}

function anonymousOwnerLinkMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  text: string;
  links: readonly string[];
}): Update {
  return {
    update_id: options.updateId ?? 26,
    message: {
      message_id: options.messageId ?? 126,
      date: 26,
      chat: chat(),
      from: {
        id: 1087968824,
        is_bot: true,
        first_name: "Group",
        username: "GroupAnonymousBot",
      },
      sender_chat: chat(),
      text: options.text,
      entities: urlEntities(options.text, options.links),
    },
  } as Update;
}

function linkMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  author?: ReturnType<typeof user>;
  text: string;
  links: readonly string[];
}): Update {
  return {
    update_id: options.updateId ?? 20,
    message: {
      message_id: options.messageId ?? 120,
      date: 20,
      chat: chat(),
      from: options.author ?? user(10, "Кирилл"),
      text: options.text,
      entities: urlEntities(options.text, options.links),
    },
  } as Update;
}

function hiddenLinkMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  text: string;
  url: string;
}): Update {
  return {
    update_id: options.updateId ?? 21,
    message: {
      message_id: options.messageId ?? 121,
      date: 21,
      chat: chat(),
      from: user(10, "Кирилл"),
      text: options.text,
      entities: [
        {
          type: "text_link",
          offset: 0,
          length: options.text.length,
          url: options.url,
        },
      ],
    },
  } as Update;
}

function forwardedGithubPostUpdate(): Update {
  const sourceTitle = "Сухарев / ЙЙ";
  const linkText = "шаблонный репозиторий";
  const text = `${sourceTitle}\nдобавил нам в ${linkText} оплату через Гугл Плей`;

  return {
    update_id: 23,
    message: {
      message_id: 123,
      date: 23,
      chat: chat(),
      from: user(10, "Кирилл"),
      forward_origin: {
        type: "channel",
        date: 22,
        chat: {
          id: -10012345,
          type: "channel",
          title: sourceTitle,
          username: "sukharev_ii",
        },
        message_id: 12345,
      },
      text,
      entities: [
        {
          type: "text_link",
          offset: text.indexOf(sourceTitle),
          length: sourceTitle.length,
          url: "https://t.me/sukharev_ii?id=12345",
        },
        {
          type: "text_link",
          offset: text.indexOf(linkText),
          length: linkText.length,
          url: "https://github.com/di-sukharev/vibe/tree/mobile",
        },
      ],
    },
  } as Update;
}

function linkedChannelAutomaticForwardUpdate(): Update {
  const sourceTitle = "Сухарев / ЙЙ";
  const text = `${sourceTitle}\nновый пост в канале`;

  return {
    update_id: 27,
    message: {
      message_id: 127,
      date: 27,
      chat: chat(),
      from: {
        id: 777000,
        is_bot: false,
        first_name: "Telegram",
      },
      sender_chat: {
        id: -10012345,
        type: "channel",
        title: sourceTitle,
        username: "sukharev_ii",
      },
      is_automatic_forward: true,
      text,
      entities: [
        {
          type: "text_link",
          offset: text.indexOf(sourceTitle),
          length: sourceTitle.length,
          url: "https://t.me/sukharev_ii/12345",
        },
      ],
    },
  } as Update;
}

function captionLinkMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  caption: string;
  links: readonly string[];
}): Update {
  return {
    update_id: options.updateId ?? 22,
    message: {
      message_id: options.messageId ?? 122,
      date: 22,
      chat: chat(),
      from: user(10, "Кирилл"),
      photo: [
        {
          file_id: "photo",
          file_unique_id: "photo-unique",
          width: 1,
          height: 1,
        },
      ],
      caption: options.caption,
      caption_entities: urlEntities(options.caption, options.links),
    },
  } as Update;
}

function editedLinkMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  text: string;
  links: readonly string[];
}): Update {
  return {
    update_id: options.updateId ?? 24,
    edited_message: {
      message_id: options.messageId ?? 124,
      date: 23,
      edit_date: 24,
      chat: chat(),
      from: user(10, "Кирилл"),
      text: options.text,
      entities: urlEntities(options.text, options.links),
    },
  } as Update;
}

function editedProfanityMessageUpdate(options: {
  updateId?: number;
  messageId?: number;
  author?: ReturnType<typeof user>;
  text: string;
}): Update {
  return {
    update_id: options.updateId ?? 25,
    edited_message: {
      message_id: options.messageId ?? 125,
      date: 24,
      edit_date: 25,
      chat: chat(),
      from: options.author ?? user(10, "Кирилл"),
      text: options.text,
    },
  } as Update;
}

function urlEntities(text: string, links: readonly string[]) {
  let searchFrom = 0;
  return links.map((link) => {
    const offset = text.indexOf(link, searchFrom);
    if (offset === -1) {
      throw new Error(`Fixture text does not contain link: ${link}`);
    }

    searchFrom = offset + link.length;
    return {
      type: "url" as const,
      offset,
      length: link.length,
    };
  });
}

function thanksReplyUpdate(): Update {
  return {
    update_id: 2,
    message: {
      message_id: 101,
      date: 2,
      chat: chat(),
      from: user(20, "Дима"),
      text: "спасибо!",
      reply_to_message: {
        message_id: 100,
        date: 1,
        chat: chat(),
        from: user(10, "Кирилл"),
        text: "Как лучше задеплоить воркер?",
      },
    },
  } as Update;
}

function reactionUpdate(
  updateId: number,
  oldReaction: NonNullable<Update["message_reaction"]>["old_reaction"],
  newReaction: NonNullable<Update["message_reaction"]>["new_reaction"],
  options: {
    actorId?: number;
    messageId?: number;
  } = {},
): Update {
  return {
    update_id: updateId,
    message_reaction: {
      chat: chat(),
      message_id: options.messageId ?? 100,
      date: updateId,
      user: user(options.actorId ?? 20, "Дима"),
      old_reaction: oldReaction,
      new_reaction: newReaction,
    },
  } as Update;
}

function actorChatReactionUpdate(
  updateId: number,
  oldReaction: NonNullable<Update["message_reaction"]>["old_reaction"],
  newReaction: NonNullable<Update["message_reaction"]>["new_reaction"],
): Update {
  return {
    update_id: updateId,
    message_reaction: {
      chat: chat(),
      message_id: 100,
      date: updateId,
      actor_chat: { id: -1002, type: "supergroup", title: "Сухарев / ЙЙ" },
      old_reaction: oldReaction,
      new_reaction: newReaction,
    },
  } as Update;
}

function reactionCountUpdate(
  updateId: number,
  reactions: NonNullable<Update["message_reaction_count"]>["reactions"],
  options: {
    messageId?: number;
  } = {},
): Update {
  return {
    update_id: updateId,
    message_reaction_count: {
      chat: chat(),
      message_id: options.messageId ?? 100,
      date: updateId,
      reactions,
    },
  } as Update;
}

function chatIdCommandUpdate(): Update {
  return {
    update_id: 10,
    message: {
      message_id: 110,
      date: 10,
      chat: chat(),
      from: user(20, "Дима"),
      text: "/chatid",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  } as Update;
}

function rulesCommandUpdate(): Update {
  return {
    update_id: 13,
    message: {
      message_id: 113,
      date: 13,
      chat: chat(),
      from: user(20, "Дима"),
      text: "/rules",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  } as Update;
}

function vibeCommandUpdate(): Update {
  return {
    update_id: 11,
    message: {
      message_id: 111,
      date: 11,
      chat: chat(),
      from: user(20, "Дима"),
      text: "/vibe",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    },
  } as Update;
}

function vibeTopCommandUpdate(): Update {
  return {
    update_id: 12,
    message: {
      message_id: 112,
      date: 12,
      chat: chat(),
      from: user(20, "Дима"),
      text: "/vibe_top",
      entities: [{ type: "bot_command", offset: 0, length: 9 }],
    },
  } as Update;
}

function chat() {
  return {
    id: -1001,
    type: "supergroup",
    title: "Students",
  };
}

function user(id: number, firstName: string, username?: string) {
  return {
    id,
    is_bot: false,
    first_name: firstName,
    username,
  };
}

function emojiReaction(emoji: ReactionTypeEmoji["emoji"]): ReactionTypeEmoji {
  return { type: "emoji" as const, emoji };
}

function telegramMethodRequests(method: string) {
  return fetchMock.requests.filter((request) => request.url.endsWith(`/${method}`));
}

class FailingStoreOnceRepository extends InMemoryCommunityBotRepository {
  private shouldFail = true;

  override async storeMessage(
    message: Parameters<InMemoryCommunityBotRepository["storeMessage"]>[0],
  ): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("temporary D1 failure");
    }

    await super.storeMessage(message);
  }
}

class FailingReactionStateOnceRepository extends InMemoryCommunityBotRepository {
  private shouldFail = true;

  override async setReactionVibeState(
    input: Parameters<InMemoryCommunityBotRepository["setReactionVibeState"]>[0],
  ): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("temporary D1 failure");
    }

    await super.setReactionVibeState(input);
  }
}

class PausingReactionStateRepository extends InMemoryCommunityBotRepository {
  private shouldPause = true;
  private readonly stateWriteStarted = createDeferred<void>();
  private readonly stateWriteResume = createDeferred<void>();

  waitForPausedStateWrite(): Promise<void> {
    return this.stateWriteStarted.promise;
  }

  resumeStateWrite(): void {
    this.stateWriteResume.resolve();
  }

  override async setReactionVibeState(
    input: Parameters<InMemoryCommunityBotRepository["setReactionVibeState"]>[0],
  ): Promise<void> {
    if (this.shouldPause) {
      this.shouldPause = false;
      this.stateWriteStarted.resolve();
      await this.stateWriteResume.promise;
    }

    await super.setReactionVibeState(input);
  }
}

class PausingThenFailingChatRepository extends InMemoryCommunityBotRepository {
  private shouldPauseAndFail = true;
  private readonly chatWriteStarted = createDeferred<void>();
  private readonly chatWriteResume = createDeferred<void>();

  waitForPausedChatWrite(): Promise<void> {
    return this.chatWriteStarted.promise;
  }

  resumeChatWrite(): void {
    this.chatWriteResume.resolve();
  }

  override async upsertChat(
    chat: Parameters<InMemoryCommunityBotRepository["upsertChat"]>[0],
  ): Promise<void> {
    if (this.shouldPauseAndFail) {
      this.shouldPauseAndFail = false;
      this.chatWriteStarted.resolve();
      await this.chatWriteResume.promise;
      throw new Error("temporary D1 failure");
    }

    await super.upsertChat(chat);
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}
