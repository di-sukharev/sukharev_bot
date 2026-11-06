import { readFileSync } from "node:fs";

type WranglerConfig = {
  vars?: Record<string, unknown>;
  queues?: {
    producers?: Array<{ binding?: unknown; queue?: unknown }>;
    consumers?: Array<{ queue?: unknown }>;
  };
};

type BotInfo = {
  id?: unknown;
  is_bot?: unknown;
  first_name?: unknown;
};

const config = Bun.TOML.parse(readFileSync("wrangler.toml", "utf8")) as WranglerConfig;
const botInfo = readBotInfo(config);
const welcomeMutedUntil = readOptionalStringVar(config, "WELCOME_MUTED_UNTIL");
const monitoredChannelIds = readOptionalStringVar(config, "MONITORED_CHANNEL_IDS")?.trim();
const channelOperatorUserId = readOptionalStringVar(config, "CHANNEL_OPERATOR_USER_ID");

if (
  typeof botInfo.id !== "number" ||
  botInfo.id <= 0 ||
  botInfo.is_bot !== true ||
  typeof botInfo.first_name !== "string" ||
  botInfo.first_name.trim() === ""
) {
  throw new Error(
    "wrangler.toml BOT_INFO must be a real Telegram getMe result before production deploy",
  );
}

if (
  welcomeMutedUntil &&
  Number.isNaN(Date.parse(welcomeMutedUntil))
) {
  throw new Error("wrangler.toml WELCOME_MUTED_UNTIL must be an ISO timestamp");
}

if (
  monitoredChannelIds &&
  !monitoredChannelIds.split(",").every((id) => /^-100\d+$/u.test(id.trim()))
) {
  throw new Error(
    "wrangler.toml MONITORED_CHANNEL_IDS must be comma-separated Telegram channel IDs that start with -100",
  );
}

if (monitoredChannelIds && !/^\d+$/u.test(channelOperatorUserId?.trim() ?? "")) {
  throw new Error(
    "wrangler.toml CHANNEL_OPERATOR_USER_ID must be a Telegram user ID when MONITORED_CHANNEL_IDS is set",
  );
}

if (monitoredChannelIds) {
  for (const binding of ["CHANNEL_JOIN_QUEUE", "CHANNEL_PROFILE_QUEUE"]) {
    const queue = config.queues?.producers?.find((producer) => producer.binding === binding)?.queue;
    if (!queue || !config.queues?.consumers?.some((consumer) => consumer.queue === queue)) {
      throw new Error(
        `wrangler.toml must bind ${binding} to a queue with a consumer when MONITORED_CHANNEL_IDS is set`,
      );
    }
  }
}

console.log("Telegram bot production vars look valid.");

function readBotInfo(wrangler: WranglerConfig): BotInfo {
  const botInfoJson = readOptionalStringVar(wrangler, "BOT_INFO");
  if (botInfoJson === null) {
    throw new Error("wrangler.toml BOT_INFO var is required");
  }

  return JSON.parse(botInfoJson) as BotInfo;
}

function readOptionalStringVar(wrangler: WranglerConfig, name: string): string | null {
  const value = wrangler.vars?.[name];
  return typeof value === "string" ? value : null;
}
