import { describe, expect, test } from "bun:test";
import {
  countNegativeReactionTotal,
  countNegativeReactions,
  countPositiveReactionTotal,
  countPositiveReactions,
  getReactionVibeDelta,
  buildRulesMessage,
  buildWelcomeMessage,
  containsProfanity,
  hasDisallowedTelegramLink,
  isThanksMessage,
  LINK_MODERATION_MESSAGE,
} from "./vibe";

describe("vibe rules", () => {
  test("detects thanks words in Russian and English", () => {
    expect(isThanksMessage("Спасибо!")).toBe(true);
    expect(isThanksMessage("спс, помогло")).toBe(true);
    expect(isThanksMessage("спасибо🙏")).toBe(true);
    expect(isThanksMessage("thank you Кирилл")).toBe(true);
    expect(isThanksMessage("thanks🙏")).toBe(true);
    expect(isThanksMessage("ty")).toBe(true);
    expect(isThanksMessage("обсуждаем типизацию")).toBe(false);
    expect(isThanksMessage("спасибочки")).toBe(false);
  });

  test("detects configured profanity words", () => {
    expect(containsProfanity("ну это badword конечно", ["badword"])).toBe(true);
    expect(containsProfanity("BADWORD!", ["badword"])).toBe(true);
    expect(containsProfanity("пребadwordинг", ["badword"])).toBe(false);
    expect(containsProfanity("badword", [])).toBe(false);
  });

  test("does not flag harmless words with profanity substrings", () => {
    expect(containsProfanity("белка")).toBe(false);
    expect(containsProfanity("страхуй")).toBe(false);
  });

  test("formats welcome rules as an expandable HTML blockquote", () => {
    const welcome = buildWelcomeMessage('User <script> & "x"');
    const rules = buildRulesMessage();

    expect(welcome.parseMode).toBe("HTML");
    expect(welcome.text).toContain("User &lt;script&gt; &amp; &quot;x&quot;");
    expect(welcome.text).toContain("<blockquote expandable>");
    expect(welcome.text).toContain(rules.text);
  });

  test("formats rules as a reusable expandable HTML message", () => {
    const rules = buildRulesMessage();

    expect(rules.parseMode).toBe("HTML");
    expect(rules.text).toContain("<blockquote expandable>");
    expect(rules.text).not.toContain("\n\n<blockquote expandable>");
    expect(rules.text).toContain("</blockquote>");
    expect(rules.text).toContain(`- ${LINK_MODERATION_MESSAGE}`);
  });

  test("allows trusted domains and main channel Telegram link entities", () => {
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://github.com/openai/codex")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("github.com/openai/codex")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://gist.github.com/user/id")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      ),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
      ),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://youtu.be/dQw4w9WgXcQ")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://www.instagram.com/p/C0ffeeCode/"),
      ),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("instagram.com/reel/C0ffeeCode/")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://sukharev.dev/")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("vibe.sukharev.dev/")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://docs.sukharev.dev/guide")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://t.me/sukharev_ii/123")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("t.me/sukharev_ii/124")),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://github.com.evil.com/openai/codex"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://instagram.com.evil.com/p/C0ffeeCode/"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://sukharev.dev.evil/")),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://evil.com/?next=https://youtube.com/watch"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://evil.com/?next=https://instagram.com/p/C0ffeeCode/"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://evil.com/?next=https://github.com/openai/codex"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://github.io/demo")),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("http://t.me/sukharev_ii/123")),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://t.me/other_channel/123")),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://t.me/sukharev_ii.evil/123")),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier(
          "https://raw.githubusercontent.com/openai/codex/main/README.md",
        ),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text: "профиль",
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 7,
            url: "https://t.me/example",
          },
        ],
      }),
    ).toBe(true);
  });

  test("allows only exact message links from the current private group", () => {
    const currentGroup = { id: -1003707812387, type: "supergroup" as const };

    for (const url of [
      "https://t.me/c/3707812387/20908",
      "https://t.me/c/3707812387/20910",
      "https://t.me/c/3707812387/20908?single",
      "https://t.me/c/3707812387/20908?thread=20900",
      "https://t.me/c/3707812387/20900/20908",
      "https://t.me/c/3707812387/20900/20908?single&t=10%3A23&task=2&option=YWJj",
      "tg://privatepost?channel=3707812387&post=20908",
      "tg://privatepost?channel=3707812387&post=20908&single&thread=20900",
    ]) {
      expect(
        hasDisallowedTelegramLink({
          ...urlLinkCarrier(url),
          chat: currentGroup,
        }),
      ).toBe(false);
    }

    for (const url of [
      "https://t.me/c/3707812388/20908",
      "http://t.me/c/3707812387/20908",
      "https://t.me/c/3707812387/not-a-message",
      "https://t.me/c/3707812387/20908/extra",
      "https://t.me/c/3707812387/20908?next=evil",
      "https://t.me/c/3707812387/20908?single=value",
      "https://t.me/c/3707812387/20908?thread=not-a-message",
      "https://t.me/c/3707812387/20900/20908?thread=20900",
      "https://t.me/c/3707812387/20908?comment=42",
      "https://t.me/c/3707812387/20908?single&single",
      "https://t.me/c/3707812387/20908?t=soon",
      "https://t.me/c/3707812387/20908?option=%25%25%25",
      "https://t.me/c/3707812387/20908#fragment",
      "tg://privatepost?channel=3707812388&post=20908",
      "tg://privatepost?channel=3707812387&post=not-a-message",
      "tg://privatepost?channel=3707812387",
      "tg://privatepost/extra?channel=3707812387&post=20908",
    ]) {
      expect(
        hasDisallowedTelegramLink({
          ...urlLinkCarrier(url),
          chat: currentGroup,
        }),
      ).toBe(true);
    }

    expect(
      hasDisallowedTelegramLink(
        urlLinkCarrier("https://t.me/c/3707812387/20908"),
      ),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        ...urlLinkCarrier("https://t.me/c/3707812387/20908"),
        chat: { ...currentGroup, type: "channel" },
      }),
    ).toBe(true);
  });

  test("ignores Cyrillic URL entities from Telegram autolinking", () => {
    expect(
      hasDisallowedTelegramLink(
        urlEntityCarrier(
          "да не может быть.. а точку вот так могли поставить.например?",
          "поставить.например",
        ),
      ),
    ).toBe(false);
    expect(hasDisallowedTelegramLink(urlLinkCarrier("пример.рф"))).toBe(false);
    expect(
      hasDisallowedTelegramLink(urlLinkCarrier("https://пример.рф/путь")),
    ).toBe(false);
  });

  test("ignores bare markdown file references from Telegram autolinking", () => {
    expect(
      hasDisallowedTelegramLink(
        urlEntityCarrier("прочитай AGENTS.md и CLAUDE.md", "AGENTS.md"),
      ),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink(
        urlEntityCarrier("прочитай AGENTS.md и CLAUDE.md", "CLAUDE.md"),
      ),
    ).toBe(false);
    expect(hasDisallowedTelegramLink(urlLinkCarrier("README.md"))).toBe(false);
    expect(hasDisallowedTelegramLink(urlLinkCarrier("https://example.md"))).toBe(
      true,
    );
  });

  test("detects hidden links even when the visible text is formatted", () => {
    const text = "важный материал";

    expect(
      hasDisallowedTelegramLink({
        text,
        entities: [
          {
            type: "bold",
            offset: 0,
            length: "важный".length,
          },
          textLinkEntity(text, "материал", "https://example.com/course"),
        ],
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text,
        entities: [
          {
            type: "italic",
            offset: 0,
            length: text.length,
          },
          textLinkEntity(text, "материал", "https://github.com/openai/codex"),
        ],
      }),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink({
        text: "подозрительный профиль",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Пользователь",
                url: "tg://user?id=123&extra=1",
              },
            ],
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text: "другой канал",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Открыть",
                url: "tg://resolve?domain=other_channel&post=123",
              },
            ],
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text: "настроить прокси",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Подключить", url: "tg://proxy?server=example.com&port=443" }],
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text: "основной канал",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Открыть",
                url: "tg://resolve?domain=sukharev_ii&post=123",
              },
            ],
          ],
        },
      }),
    ).toBe(false);
  });

  test("detects forbidden links in inline keyboard buttons", () => {
    expect(
      hasDisallowedTelegramLink({
        text: "получить подарок",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Открыть", url: "https://example.com/claim" }],
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text: "исходники",
        reply_markup: {
          inline_keyboard: [
            [{ text: "GitHub", url: "https://github.com/openai/codex" }],
            [{ text: "Действие", callback_data: "safe" }],
          ],
        },
      }),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink({
        text: "профиль",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Пользователь", url: "tg://user?id=123" }],
          ],
        },
      }),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink({
        text: "авторизация",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Войти",
                login_url: { url: "https://example.com/login" },
              },
            ],
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        text: "приложение",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Открыть",
                web_app: { url: "https://example.com/app" },
              },
            ],
          ],
        },
      }),
    ).toBe(true);
  });

  test("ignores only the exact Telegram source permalink on forwarded posts", () => {
    const text = "Другой канал\nrepo";
    const forwardedGithubPost = {
      text,
      forward_origin: {
        type: "channel" as const,
        date: 1,
        chat: {
          id: -10012345,
          type: "channel" as const,
          title: "Другой канал",
          username: "other_channel",
        },
        message_id: 12345,
      },
      entities: [
        textLinkEntity(text, "Другой канал", "https://t.me/other_channel/12345"),
        textLinkEntity(text, "repo", "https://github.com/di-sukharev/vibe"),
      ],
    };

    expect(hasDisallowedTelegramLink(forwardedGithubPost)).toBe(false);
    expect(
      hasDisallowedTelegramLink({
        ...forwardedGithubPost,
        entities: [
          textLinkEntity(text, "repo", "https://github.com/di-sukharev/vibe"),
        ],
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Другой канал",
                url: "https://t.me/other_channel/12345",
              },
            ],
          ],
        },
      }),
    ).toBe(false);
    expect(
      hasDisallowedTelegramLink({
        ...forwardedGithubPost,
        entities: [
          textLinkEntity(text, "Другой канал", "https://t.me/other_channel/54321"),
          textLinkEntity(text, "repo", "https://github.com/di-sukharev/vibe"),
        ],
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        ...forwardedGithubPost,
        entities: [
          textLinkEntity(text, "Другой канал", "https://t.me/other_channel/12345"),
          textLinkEntity(text, "repo", "https://example.com"),
        ],
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        ...forwardedGithubPost,
        entities: [
          textLinkEntity(
            text,
            "Другой канал",
            "https://t.me/other_channel/12345/extra",
          ),
          textLinkEntity(text, "repo", "https://github.com/di-sukharev/vibe"),
        ],
      }),
    ).toBe(true);
    expect(
      hasDisallowedTelegramLink({
        ...forwardedGithubPost,
        entities: [
          textLinkEntity(
            text,
            "Другой канал",
            "tg://resolve?domain=other_channel&post=12345&extra=1",
          ),
          textLinkEntity(text, "repo", "https://github.com/di-sukharev/vibe"),
        ],
      }),
    ).toBe(true);
  });

  test("rejects malformed or extended main-channel permalinks", () => {
    for (const url of [
      "https://t.me/sukharev_ii/not-a-message",
      "https://t.me/sukharev_ii/123/extra",
      "https://t.me/sukharev_ii/123?next=evil",
      "tg://resolve?domain=sukharev_ii&post=not-a-message",
      "tg://resolve?domain=sukharev_ii&post=123&extra=1",
    ]) {
      expect(hasDisallowedTelegramLink(urlLinkCarrier(url))).toBe(true);
    }
  });

  test("counts only supported positive emoji reactions", () => {
    expect(
      countPositiveReactions([
        { type: "emoji", emoji: "👍" },
        { type: "emoji", emoji: "❤" },
        { type: "emoji", emoji: "🔥" },
        { type: "emoji", emoji: "🙏" },
        { type: "emoji", emoji: "😂" },
        { type: "emoji", emoji: "😁" },
        { type: "emoji", emoji: "😍" },
        { type: "emoji", emoji: "🤝" },
        { type: "emoji", emoji: "😐" },
        { type: "custom_emoji", custom_emoji_id: "custom" },
      ]),
    ).toBe(8);
  });

  test("counts supported positive aggregate reaction totals", () => {
    expect(
      countPositiveReactionTotal([
        { type: { type: "emoji", emoji: "❤" }, total_count: 2 },
        { type: { type: "emoji", emoji: "🤝" }, total_count: 1 },
        { type: { type: "emoji", emoji: "😐" }, total_count: 5 },
      ]),
    ).toBe(3);
  });

  test("counts poop and thumbs-down reactions as negative vibe", () => {
    expect(
      countNegativeReactions([
        { type: "emoji", emoji: "💩" },
        { type: "emoji", emoji: "👎" },
        { type: "emoji", emoji: "👍" },
        { type: "custom_emoji", custom_emoji_id: "custom" },
      ]),
    ).toBe(2);
    expect(
      countNegativeReactionTotal([
        { type: { type: "emoji", emoji: "💩" }, total_count: 3 },
        { type: { type: "emoji", emoji: "👎" }, total_count: 2 },
        { type: { type: "emoji", emoji: "👍" }, total_count: 2 },
      ]),
    ).toBe(5);
  });

  test("computes reaction add and removal deltas", () => {
    expect(getReactionVibeDelta([], [{ type: "emoji", emoji: "👍" }])).toBe(1);
    expect(getReactionVibeDelta([{ type: "emoji", emoji: "👍" }], [])).toBe(-1);
    expect(getReactionVibeDelta([], [{ type: "emoji", emoji: "💩" }])).toBe(-1);
    expect(getReactionVibeDelta([{ type: "emoji", emoji: "💩" }], [])).toBe(1);
    expect(getReactionVibeDelta([], [{ type: "emoji", emoji: "👎" }])).toBe(-1);
    expect(getReactionVibeDelta([{ type: "emoji", emoji: "👎" }], [])).toBe(1);
    expect(
      getReactionVibeDelta(
        [{ type: "emoji", emoji: "👍" }],
        [{ type: "emoji", emoji: "🔥" }],
      ),
    ).toBe(0);
    expect(
      getReactionVibeDelta(
        [{ type: "emoji", emoji: "👍" }],
        [{ type: "emoji", emoji: "💩" }],
      ),
    ).toBe(-2);
  });
});

function urlLinkCarrier(text: string) {
  return {
    text,
    entities: [{ type: "url" as const, offset: 0, length: text.length }],
  };
}

function urlEntityCarrier(text: string, link: string) {
  const offset = text.indexOf(link);
  if (offset === -1) {
    throw new Error(`Fixture text does not contain link: ${link}`);
  }

  return {
    text,
    entities: [{ type: "url" as const, offset, length: link.length }],
  };
}

function textLinkEntity(text: string, label: string, url: string) {
  const offset = text.indexOf(label);
  if (offset === -1) {
    throw new Error(`Fixture text does not contain label: ${label}`);
  }

  return {
    type: "text_link" as const,
    offset,
    length: label.length,
    url,
  };
}
