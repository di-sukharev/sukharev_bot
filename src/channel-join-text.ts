import type { ChannelJoinEntry, ChannelJoinOutcome } from "./types";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export const OUTCOME_MARKS: Record<ChannelJoinOutcome, string> = {
  allowed: "•",
  checking: "⏳",
  banned: "⛔",
  ban_failed: "⚠️",
  unbanned: "↩️",
};

const MOSCOW_TIME = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatMoscowTime(date: Date): string {
  return MOSCOW_TIME.format(date);
}

export function formatSubscriber(
  subscriber: Pick<ChannelJoinEntry, "userId" | "displayName" | "username">,
): string {
  const username = subscriber.username ? ` @${subscriber.username}` : "";
  return `${subscriber.displayName}${username} · ${subscriber.userId}`;
}

// Keeps the lines that fit into one message and counts the rest.
export function fitMessage(header: string[], lines: string[]): string {
  const text = [...header, ...lines].join("\n");
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return text;
  }

  const overflowRoom = `\n… и ещё ${lines.length}.`.length;
  let length = header.join("\n").length;
  let shown = 0;
  while (length + 1 + lines[shown]!.length + overflowRoom <= TELEGRAM_MESSAGE_LIMIT) {
    length += 1 + lines[shown]!.length;
    shown += 1;
  }

  return [...header, ...lines.slice(0, shown), `… и ещё ${lines.length - shown}.`].join("\n");
}
