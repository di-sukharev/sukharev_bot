import type {
  Chat,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  MessageEntity,
  MessageOrigin,
  ReactionCount,
  ReactionType,
} from "grammy/types";

type ReactionLike = ReactionType | { type: "emoji"; emoji: string };

// Add exact profanity words here; the bot treats the list as case-insensitive.
export const PROFANITY_WORDS: readonly string[] = ['ёбаная','ебал','ебать','убивать', 'убейся', 'убийство', 'шлюха', 'шлюхи', 'шлюхами', 'нихуя','въебут','въеб','вьеб','вьебал','вьебать','въебал','въебать','въебали','въебать','въебался','ахуй','ахуенно','ахуеть','бля', 'блять', 'сука', 'ебать', 'нахуй', 'хуйня', 'пиздец', 'пизда', 'хуета', 'хуй', 'хуйни', 'пизды', 'епта', 'хуеты', 'ебли', 'ебка', 'бляя', 'бляяя', 'пиздос', "заёб", "заеб", "заебло", "заебало", "заебисто", "заебался", "заеба"];

export const POSITIVE_REACTION_EMOJI = new Set([
  "👍",
  "❤️",
  "❤",
  "🔥",
  "👏",
  "🙌",
  "💯",
  "🫶",
  "🙏",
  "😂",
  "😁",
  "😍",
  "🤝",
]);

export const NEGATIVE_REACTION_EMOJI = new Set(["💩", "👎"]);

const THANKS_MESSAGE_PATTERN =
  /(?:^|[\p{Separator}\p{Punctuation}\p{Symbol}])(?:спасибо|спс|благодарю|thanks|thank\s+you|ty)(?:$|[\p{Separator}\p{Punctuation}\p{Symbol}])/iu;

const WORD_BOUNDARY = String.raw`(?:^|[^\p{Letter}\p{Number}_])`;
const WORD_END_BOUNDARY = String.raw`(?=$|[^\p{Letter}\p{Number}_])`;
const MAIN_CHANNEL_USERNAME = "sukharev_ii";
const BARE_MARKDOWN_FILE_REFERENCES = new Set([
  "agents.md",
  "claude.md",
  "readme.md",
]);

export function isThanksMessage(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }

  return THANKS_MESSAGE_PATTERN.test(text.trim().replaceAll("ё", "е"));
}

export function containsProfanity(
  text: string | undefined | null,
  words: readonly string[] = PROFANITY_WORDS,
): boolean {
  if (!text || words.length === 0) {
    return false;
  }

  const normalizedText = normalizeProfanityText(text);
  return words.some((word) => {
    const normalizedWord = normalizeProfanityText(word);
    if (!normalizedWord) {
      return false;
    }

    return new RegExp(
      `${WORD_BOUNDARY}${escapeRegExp(normalizedWord)}${WORD_END_BOUNDARY}`,
      "iu",
    ).test(normalizedText);
  });
}

export type TelegramLinkCarrier = {
  text?: string | null;
  caption?: string | null;
  entities?: readonly MessageEntity[];
  caption_entities?: readonly MessageEntity[];
  forward_origin?: MessageOrigin | null;
  reply_markup?: InlineKeyboardMarkup;
  chat?: Pick<Chat, "id" | "type">;
};

export function hasDisallowedTelegramLink(message: TelegramLinkCarrier): boolean {
  return (
    hasDisallowedLinkInText(
      message.text,
      message.entities,
      message.forward_origin,
      message.chat,
    ) ||
    hasDisallowedLinkInText(
      message.caption,
      message.caption_entities,
      message.forward_origin,
      message.chat,
    ) ||
    hasDisallowedInlineKeyboardLink(
      message.reply_markup,
      message.forward_origin,
      message.chat,
    )
  );
}

function hasDisallowedInlineKeyboardLink(
  replyMarkup: InlineKeyboardMarkup | undefined,
  forwardOrigin: MessageOrigin | undefined | null,
  chat: TelegramLinkCarrier["chat"],
): boolean {
  return replyMarkup?.inline_keyboard.some((row) => {
    return row.some((button) => {
      const value = getInlineKeyboardButtonUrl(button);
      if (!value) {
        return false;
      }

      const url = parseTelegramUrl(value);
      return (
        url !== null &&
        (url.protocol === "http:" ||
          url.protocol === "https:" ||
          url.protocol === "tg:") &&
        !isAllowedTelegramLink(value, forwardOrigin, chat)
      );
    });
  }) ?? false;
}

function getInlineKeyboardButtonUrl(button: InlineKeyboardButton): string | null {
  if ("url" in button) {
    return button.url;
  }

  if ("login_url" in button) {
    return button.login_url.url;
  }

  if ("web_app" in button) {
    return button.web_app.url;
  }

  return null;
}

function hasDisallowedLinkInText(
  text: string | undefined | null,
  entities: readonly MessageEntity[] | undefined,
  forwardOrigin: MessageOrigin | undefined | null,
  chat: TelegramLinkCarrier["chat"],
): boolean {
  if (!text || !entities || entities.length === 0) {
    return false;
  }

  return entities.some((entity) => {
    const url = getTelegramLinkEntityUrl(text, entity);
    return (
      url !== null &&
      !isIgnoredVisibleTelegramUrlEntity(url, entity) &&
      hasAsciiTelegramUrlHost(url) &&
      !isAllowedTelegramLink(url, forwardOrigin, chat)
    );
  });
}

function getTelegramLinkEntityUrl(text: string, entity: MessageEntity): string | null {
  if (entity.type === "url") {
    return text.substring(entity.offset, entity.offset + entity.length);
  }

  if (entity.type === "text_link") {
    return entity.url;
  }

  return null;
}

function isIgnoredVisibleTelegramUrlEntity(
  value: string,
  entity: MessageEntity,
): boolean {
  return entity.type === "url" && isBareMarkdownFileReference(value);
}

function isBareMarkdownFileReference(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return BARE_MARKDOWN_FILE_REFERENCES.has(normalized);
}

function isAllowedTelegramLink(
  value: string,
  forwardOrigin: MessageOrigin | undefined | null,
  chat: TelegramLinkCarrier["chat"],
): boolean {
  return (
    isAllowedGithubUrl(value) ||
    isAllowedYoutubeUrl(value) ||
    isAllowedInstagramUrl(value) ||
    isAllowedTelegramUserMentionUrl(value) ||
    isAllowedMainChannelTelegramUrl(value) ||
    isCurrentChatTelegramMessageUrl(value, chat) ||
    isForwardOriginPermalink(value, forwardOrigin)
  );
}

function isAllowedTelegramUserMentionUrl(value: string): boolean {
  const url = parseTelegramUrl(value);
  return (
    url?.protocol === "tg:" &&
    url.hostname.toLowerCase() === "user" &&
    /^\d+$/u.test(url.searchParams.get("id") ?? "") &&
    hasExactSearchParams(url, ["id"]) &&
    url.hash === ""
  );
}

function isAllowedGithubUrl(value: string): boolean {
  const url = parseTelegramUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

function isAllowedYoutubeUrl(value: string): boolean {
  const url = parseTelegramUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtu.be"
  );
}

function isAllowedInstagramUrl(value: string): boolean {
  const url = parseTelegramUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return hostname === "instagram.com" || hostname.endsWith(".instagram.com");
}

function isAllowedMainChannelTelegramUrl(value: string): boolean {
  const url = parseTelegramUrl(value);
  if (!url) {
    return false;
  }

  if (url.protocol === "tg:" && url.hostname.toLowerCase() === "resolve") {
    return (
      normalizeTelegramUsername(url.searchParams.get("domain")) ===
        MAIN_CHANNEL_USERNAME &&
      isTelegramMessageId(url.searchParams.get("post")) &&
      hasExactSearchParams(url, ["domain", "post"]) &&
      url.hash === ""
    );
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "t.me") {
    return false;
  }
  const pathParts = url.pathname.split("/").filter(Boolean);
  const [pathUsername, pathMessageId] = pathParts;
  return (
    pathParts.length === 2 &&
    normalizeTelegramUsername(pathUsername) === MAIN_CHANNEL_USERNAME &&
    isTelegramMessageId(pathMessageId) &&
    url.search === "" &&
    url.hash === ""
  );
}

function isCurrentChatTelegramMessageUrl(
  value: string,
  chat: TelegramLinkCarrier["chat"],
): boolean {
  const privateChatId = getTelegramPrivateChatLinkId(chat);
  if (!privateChatId) {
    return false;
  }

  const url = parseTelegramUrl(value);
  if (!url) {
    return false;
  }

  if (url.protocol === "tg:" && url.hostname.toLowerCase() === "privatepost") {
    return (
      url.pathname === "" &&
      hasValidTelegramMessageLinkParams(url, false, privateChatId) &&
      url.hash === ""
    );
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "t.me") {
    return false;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const hasThreadInPath = pathParts.length === 4;
  const messageId = pathParts.at(-1);
  return (
    (pathParts.length === 3 || hasThreadInPath) &&
    pathParts[0] === "c" &&
    pathParts[1] === privateChatId &&
    (!hasThreadInPath || isTelegramMessageId(pathParts[2])) &&
    isTelegramMessageId(messageId) &&
    hasValidTelegramMessageLinkParams(url, hasThreadInPath) &&
    url.hash === ""
  );
}

function hasValidTelegramMessageLinkParams(
  url: URL,
  hasThreadInPath: boolean,
  privateChatId?: string,
): boolean {
  const seenKeys = new Set<string>();

  for (const [key, value] of url.searchParams) {
    if (seenKeys.has(key)) {
      return false;
    }
    seenKeys.add(key);

    switch (key) {
      case "channel":
        if (privateChatId === undefined || value !== privateChatId) {
          return false;
        }
        break;
      case "post":
        if (privateChatId === undefined || !isTelegramMessageId(value)) {
          return false;
        }
        break;
      case "single":
        if (value !== "") {
          return false;
        }
        break;
      case "thread":
        if (hasThreadInPath || !isTelegramMessageId(value)) {
          return false;
        }
        break;
      case "task":
        if (!isTelegramMessageId(value)) {
          return false;
        }
        break;
      case "t":
        if (!isTelegramMediaTimestamp(value)) {
          return false;
        }
        break;
      case "option":
        if (!isValidBase64UrlUtf8(value)) {
          return false;
        }
        break;
      default:
        return false;
    }
  }

  return (
    privateChatId === undefined ||
    (seenKeys.has("channel") && seenKeys.has("post"))
  );
}

function isTelegramMediaTimestamp(value: string): boolean {
  return (
    /^\d+$/u.test(value) ||
    /^\d+:\d{1,2}$/u.test(value) ||
    /^(?=\d)(?:(?:\d+)h)?(?:(?:\d{1,2})m)?(?:(?:\d{1,2})s)?$/u.test(value)
  );
}

function isValidBase64UrlUtf8(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || value.length % 4 === 1) {
    return false;
  }

  const unpadded = value.replace(/=+$/u, "");
  const padding = "=".repeat((4 - (unpadded.length % 4)) % 4);

  try {
    const decoded = atob(unpadded.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function getTelegramPrivateChatLinkId(
  chat: TelegramLinkCarrier["chat"],
): string | null {
  if (chat?.type !== "supergroup") {
    return null;
  }

  const match = String(chat.id).match(/^-100([1-9]\d*)$/u);
  return match?.[1] ?? null;
}

function isForwardOriginPermalink(
  value: string,
  forwardOrigin: MessageOrigin | undefined | null,
): boolean {
  if (forwardOrigin?.type !== "channel") {
    return false;
  }

  const username = normalizeTelegramUsername(forwardOrigin.chat.username);
  if (!username) {
    return false;
  }

  const url = parseTelegramUrl(value);
  if (!url) {
    return false;
  }

  if (url.protocol === "tg:" && url.hostname.toLowerCase() === "resolve") {
    return (
      normalizeTelegramUsername(url.searchParams.get("domain")) === username &&
      url.searchParams.get("post") === String(forwardOrigin.message_id) &&
      hasExactSearchParams(url, ["domain", "post"]) &&
      url.hash === ""
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== "t.me" && hostname !== "telegram.me") {
    return false;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const [pathUsername, pathMessageId] = pathParts;
  if (normalizeTelegramUsername(pathUsername) !== username) {
    return false;
  }

  const messageId = String(forwardOrigin.message_id);
  const isPathPermalink =
    pathParts.length === 2 &&
    pathMessageId === messageId &&
    url.search === "";
  const isLegacyQueryPermalink =
    pathParts.length === 1 &&
    url.searchParams.get("id") === messageId &&
    hasExactSearchParams(url, ["id"]);
  return (isPathPermalink || isLegacyQueryPermalink) && url.hash === "";
}

function isTelegramMessageId(value: string | undefined | null): boolean {
  return value !== null && value !== undefined && /^[1-9]\d*$/u.test(value);
}

function hasExactSearchParams(url: URL, expectedKeys: readonly string[]): boolean {
  let count = 0;
  let onlyExpectedKeys = true;
  url.searchParams.forEach((_value, key) => {
    count += 1;
    if (!expectedKeys.includes(key)) {
      onlyExpectedKeys = false;
    }
  });
  return onlyExpectedKeys && count === expectedKeys.length;
}

function parseTelegramUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed);
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
      return null;
    }
  }

  try {
    return new URL(`https://${trimmed}`);
  } catch {
    return null;
  }
}

function hasAsciiTelegramUrlHost(value: string): boolean {
  const host = extractRawTelegramUrlHost(value);
  return host !== null && host.length > 0 && /^[\x00-\x7F]+$/u.test(host);
}

function extractRawTelegramUrlHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const authority = withoutScheme.split(/[/?#]/u)[0];
  if (!authority) {
    return null;
  }

  const hostWithPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostWithPort.startsWith("[")) {
    const closingBracketIndex = hostWithPort.indexOf("]");
    return closingBracketIndex === -1
      ? hostWithPort
      : hostWithPort.slice(0, closingBracketIndex + 1);
  }

  return hostWithPort.split(":")[0] ?? null;
}

function normalizeProfanityText(value: string): string {
  return value.trim().toLowerCase().replaceAll("ё", "е");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countPositiveReactions(reactions: readonly ReactionLike[]): number {
  return reactions.filter((reaction) => {
    return reaction.type === "emoji" && POSITIVE_REACTION_EMOJI.has(reaction.emoji);
  }).length;
}

export function countNegativeReactions(reactions: readonly ReactionLike[]): number {
  return reactions.filter((reaction) => {
    return reaction.type === "emoji" && NEGATIVE_REACTION_EMOJI.has(reaction.emoji);
  }).length;
}

export function countPositiveReactionTotal(reactions: readonly ReactionCount[]): number {
  return reactions.reduce((total, reaction) => {
    if (
      reaction.type.type === "emoji" &&
      POSITIVE_REACTION_EMOJI.has(reaction.type.emoji)
    ) {
      return total + reaction.total_count;
    }

    return total;
  }, 0);
}

export function countNegativeReactionTotal(reactions: readonly ReactionCount[]): number {
  return reactions.reduce((total, reaction) => {
    if (
      reaction.type.type === "emoji" &&
      NEGATIVE_REACTION_EMOJI.has(reaction.type.emoji)
    ) {
      return total + reaction.total_count;
    }

    return total;
  }, 0);
}

export function getReactionVibeDelta(
  oldReactions: readonly ReactionLike[],
  newReactions: readonly ReactionLike[],
): number {
  const positiveDelta =
    countPositiveReactions(newReactions) - countPositiveReactions(oldReactions);
  const negativeDelta =
    countNegativeReactions(newReactions) - countNegativeReactions(oldReactions);
  return positiveDelta - negativeDelta;
}

export function parseIdSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function parseUsernameSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeTelegramUsername)
      .filter((entry): entry is string => entry !== null),
  );
}

export function normalizeTelegramUsername(value: string | undefined | null): string | null {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase();
  return normalized ? normalized : null;
}

export function parseBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test((value ?? "").trim());
}

export function isChatAllowed(chatId: string, allowedChatIds: Set<string>): boolean {
  return allowedChatIds.has(chatId);
}

export function formatVibeScore(score: number): string {
  return `${score} вайба`;
}

export function formatVibeScoreParenthetical(score: number | null): string {
  return score === null ? "" : ` (${formatVibeScore(score)})`;
}

export type HtmlMessage = {
  text: string;
  parseMode: "HTML";
};

export const LINK_MODERATION_MESSAGE =
  "ссылки отправлять нельзя, кроме GitHub, YouTube, Instagram, сообщений из этой группы и постов из канала @sukharev_ii; любые ссылки можно отправлять с 25 вайба. хорошие от плохих разделить сложно, поэтому до 25 вайба нельзя никакие другие. отправляйте ссылки друг другу в личку (пожалуйста, все будьте аккуратнее, открывая ссылки).";

const PROFANITY_MODERATION_REASON = "сквернословие запрещено 🐿️";

export function buildProfanityModerationMessage(currentScore: number | null = null): string {
  return `минус 1 вайб${formatVibeScoreParenthetical(currentScore)}: ${PROFANITY_MODERATION_REASON}`;
}

export const PROFANITY_MODERATION_MESSAGE = buildProfanityModerationMessage();

const CHAT_RULES_TEXT = [
  `- ${LINK_MODERATION_MESSAGE}`,
  "",
  "- нельзя материться: может быть, это кринж, но разделять нормальный мат от не нормального сложно, поэтому нельзя никакой).",
  "",
  "- оскорблять друг друга тоже нельзя: пишите друг другу ругательства в личку) а лучше не ругайтесь.",
  "",
  "- не пишите, плиз, вне темы программирования, разработки, ии, ыы, йй и т. д.",
  "",
  "- гараж продавать не надо.",
  "",
  "я буду банить за нарушение 🏏",
  "",
  "и, разумеется, можно оспорить бан тут: @haltmachina",
].join("\n");

export function buildRulesMessage(): HtmlMessage {
  return {
    parseMode: "HTML",
    text: [
      "в чате есть правила:",
      `<blockquote expandable>${escapeTelegramHtml(CHAT_RULES_TEXT)}</blockquote>`,
    ].join("\n"),
  };
}

export function buildWelcomeMessage(displayName: string): HtmlMessage {
  const rules = buildRulesMessage();
  return {
    parseMode: "HTML",
    text: [
      `привет ${escapeTelegramHtml(displayName)}, добро пожаловать к нам в чат 🐿️🦫🦖`,
      "",
      "если хочешь, можешь рассказать, чем занимаешься, в 2-3 предложениях)",
      "",
      rules.text,
    ].join("\n"),
  };
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return char;
    }
  });
}

export function buildAwardMessage(
  delta: number,
  displayName: string,
  currentScore: number | null = null,
): string {
  const prefix = delta > 0 ? `+${delta}` : String(delta);
  const vibeWord = Math.abs(delta) === 1 ? "вайб" : "вайба";
  return `${displayName}, вам ${prefix} ${vibeWord}${formatVibeScoreParenthetical(currentScore)}`;
}
