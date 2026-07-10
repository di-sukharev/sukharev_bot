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

  test("allows GitHub, YouTube, Instagram, and main channel Telegram link entities", () => {
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
