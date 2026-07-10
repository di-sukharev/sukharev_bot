import type {
  MessageEntity,
  MessageOrigin,
  ReactionCount,
  ReactionType,
} from "grammy/types";

type ReactionLike = ReactionType | { type: "emoji"; emoji: string };

// Add exact profanity words here; the bot treats the list as case-insensitive.
export const PROFANITY_WORDS: readonly string[] = ['нихуя','въебут','въеб','вьеб','вьебал','въебал','въебали','въебался','ахуй','ахуенно','ахуеть','бля', 'блять', 'сука', 'ебать', 'нахуй', 'хуйня', 'пиздец', 'пизда', 'хуета', 'хуй', 'хуйни', 'пизды', 'епта', 'хуеты', 'ебли', 'ебка', 'бляя', 'бляяя', 'пиздос', "заёб", "заеб", "заебло", "заебало", "заебисто", "заебался", "заеба"];

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
};

export function hasDisallowedTelegramLink(message: TelegramLinkCarrier): boolean {
  return (
    hasDisallowedLinkInText(message.text, message.entities, message.forward_origin) ||
    hasDisallowedLinkInText(
      message.caption,
      message.caption_entities,
      message.forward_origin,
    )
  );
}

function hasDisallowedLinkInText(
  text: string | undefined | null,
  entities: readonly MessageEntity[] | undefined,
  forwardOrigin: MessageOrigin | undefined | null,
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
      !isAllowedTelegramLink(url, forwardOrigin)
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
): boolean {
  return (
    isAllowedGithubUrl(value) ||
    isAllowedYoutubeUrl(value) ||
    isAllowedInstagramUrl(value) ||
    isAllowedMainChannelTelegramUrl(value) ||
    isForwardOriginPermalink(value, forwardOrigin)
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
  if (!url || url.protocol !== "https:") {
    return false;
  }

  if (url.hostname.toLowerCase() !== "t.me") {
    return false;
  }

  const [pathUsername, pathMessageId] = url.pathname.split("/").filter(Boolean);
  return (
    normalizeTelegramUsername(pathUsername) === MAIN_CHANNEL_USERNAME &&
    Boolean(pathMessageId)
  );
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
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== "t.me" && hostname !== "telegram.me") {
    return false;
  }

  const [pathUsername, pathMessageId] = url.pathname
    .split("/")
    .filter(Boolean);
  if (normalizeTelegramUsername(pathUsername) !== username) {
    return false;
  }

  const messageId = String(forwardOrigin.message_id);
  return pathMessageId === messageId || url.searchParams.get("id") === messageId;
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
  "ссылки отправлять нельзя, кроме GitHub, YouTube, Instagram и постов из канала @sukharev_ii; любые ссылки можно отправлять с 25 вайба. хорошие от плохих разделить сложно, поэтому до 25 вайба нельзя никакие другие. отправляйте ссылки друг другу в личку (пожалуйста, все будьте аккуратнее, открывая ссылки).";

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
