import { readFileSync } from "node:fs";

type BotInfo = {
  id?: unknown;
  is_bot?: unknown;
  first_name?: unknown;
};

const wranglerToml = readFileSync("wrangler.toml", "utf8");
const botInfo = readBotInfo(wranglerToml);
const welcomeMutedUntil = readOptionalStringVar(wranglerToml, "WELCOME_MUTED_UNTIL");

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

console.log("Telegram bot production vars look valid.");

function readBotInfo(toml: string): BotInfo {
  const match = readStringVarMatch(toml, "BOT_INFO");
  if (!match) {
    throw new Error("wrangler.toml BOT_INFO var is required");
  }

  const botInfoJson = JSON.parse(match[1] ?? "") as string;
  return JSON.parse(botInfoJson) as BotInfo;
}

function readOptionalStringVar(toml: string, name: string): string | null {
  const match = readStringVarMatch(toml, name);
  if (!match) {
    return null;
  }

  return JSON.parse(match[1] ?? "") as string;
}

function readStringVarMatch(toml: string, name: string): RegExpMatchArray | null {
  return toml.match(new RegExp(`^\\s*${name}\\s*=\\s*(\".*\")\\s*$`, "m"));
}

export {};
