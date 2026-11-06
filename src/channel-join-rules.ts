import type { ChatFullInfo, User } from "grammy/types";
import type { ChannelJoinProfile } from "./types";

// What the monitor does with a new subscriber before it reads the profile.
export type SubscriberVerdict = "ban" | "check" | "allow";

// The farm rule that a subscriber matches. A Premium farm username only asks
// for a profile check.
export type SubscriberRule =
  | "foreign_script"
  | "farm_username"
  | "premium_latin_name"
  | "premium_farm_username";

// Usernames that the subscriber farm generated in the flood of 2026-11-06.
const RANDOM_FARM_USERNAME = /^(?:[a-z]{5}_[a-z]{5}|[a-z]{10})\d{3}$/u;
// Exactly 3 digits at the end of the username. People often pick 123.
const FARM_DIGITS = /(?<!\d)(?!123$)\d{3}$/u;
const LATIN_NAME = /^[A-Za-z][A-Za-z'’-]{2,}$/u;
// Scripts of farm names that the channel audience does not write in: South Asian
// scripts (Indian scripts and Sinhala), the Arabic script (also Urdu and
// Persian), and Chinese characters.
const FOREIGN_SCRIPT = new RegExp(
  `[${[
    "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu",
    "Kannada", "Malayalam", "Sinhala", "Arabic", "Han",
  ].map((script) => `\\p{Script=${script}}`).join("")}]`,
  "u",
);

export function classifySubscriber(user: User): SubscriberVerdict {
  const rule = matchSubscriberRule(user);
  return rule === null ? "allow" : rule === "premium_farm_username" ? "check" : "ban";
}

export function matchSubscriberRule(user: User): SubscriberRule | null {
  const username = user.username ?? "";
  const farmDigits = FARM_DIGITS.test(username);
  if (FOREIGN_SCRIPT.test(`${user.first_name} ${user.last_name ?? ""}`)) {
    return "foreign_script";
  }

  if (
    isNameSuffixUsername(user, username) ||
    (farmDigits && (RANDOM_FARM_USERNAME.test(username) || isNameChunkUsername(user, username)))
  ) {
    return "farm_username";
  }

  // The farm also uses Premium accounts with 3 digits at the end of the username.
  if (farmDigits && user.is_premium === true) {
    return hasLatinNames(user) ? "premium_latin_name" : "premium_farm_username";
  }

  return null;
}

// Premium farm profiles show a photo, but no bio, personal channel, custom emoji
// status, or profile audio.
export function isFarmProfile(profile: ChannelJoinProfile): boolean {
  return (
    profile.hasPhoto &&
    !profile.hasBio &&
    !profile.hasPersonalChat &&
    !profile.hasEmojiStatus &&
    !profile.hasProfileAudio
  );
}

export function readSubscriberProfile(chat: ChatFullInfo): ChannelJoinProfile {
  return {
    hasBio: Boolean(chat.bio?.trim()),
    hasPersonalChat: chat.personal_chat !== undefined,
    hasEmojiStatus: chat.emoji_status_custom_emoji_id !== undefined,
    hasProfileAudio: chat.first_profile_audio !== undefined,
    hasPhoto: chat.photo !== undefined,
  };
}

function hasLatinNames(user: User): boolean {
  return LATIN_NAME.test(user.first_name.trim()) && LATIN_NAME.test(user.last_name?.trim() ?? "");
}

// Example: Vicenta Arnold → ArnolVicen453 or Arnol_Vicen453.
function isNameChunkUsername(user: User, username: string): boolean {
  const lastName = user.last_name?.trim();
  if (!lastName) {
    return false;
  }

  const first = user.first_name.trim().slice(0, 5).toLowerCase();
  const last = lastName.slice(0, 5).toLowerCase();
  const head = username.slice(0, -3).toLowerCase();
  return [first + last, `${first}_${last}`, last + first, `${last}_${first}`].includes(head);
}

// Example: Antonina Klimanova → antoninaklimanovayp or antonina_klimanovayp.
function isNameSuffixUsername(user: User, username: string): boolean {
  const first = user.first_name.trim().toLowerCase();
  const last = user.last_name?.trim().toLowerCase() ?? "";
  if (!/^[a-z]+$/u.test(first) || !/^[a-z]+$/u.test(last)) {
    return false;
  }

  // Both names hold only Latin letters, so they need no escaping.
  return new RegExp(`^${first}_?${last}[a-z]{1,3}$`, "u").test(username.toLowerCase());
}
