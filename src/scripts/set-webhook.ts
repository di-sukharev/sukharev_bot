const allowedUpdates = [
  "message",
  "edited_message",
  "chat_member",
  "message_reaction",
  "message_reaction_count",
];

requireCleanGitTree();

const botToken = readRequiredEnv("BOT_TOKEN");
const secretToken = readRequiredEnv("TELEGRAM_WEBHOOK_SECRET");
const webhookUrl = readRequiredEnv("TELEGRAM_WEBHOOK_URL");
const allowedWebhookHost = readRequiredEnv("TELEGRAM_WEBHOOK_ALLOWED_HOST");
validateWebhookUrl(webhookUrl, allowedWebhookHost);
const dropPendingUpdates = /^(1|true|yes|on)$/iu.test(
  process.env.TELEGRAM_DROP_PENDING_UPDATES ?? "",
);

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: allowedUpdates,
    max_connections: 1,
    drop_pending_updates: dropPendingUpdates,
  }),
});

const body = (await response.json()) as {
  ok?: boolean;
  description?: string;
  result?: unknown;
};

if (!response.ok || body.ok !== true) {
  throw new Error(
    `Telegram setWebhook failed: ${response.status} ${body.description ?? JSON.stringify(body)}`,
  );
}

console.log(`Webhook set: ${webhookUrl}`);
console.log(`Allowed updates: ${allowedUpdates.join(", ")}`);
console.log("Max connections: 1");

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function validateWebhookUrl(value: string, allowedHost: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/telegram/webhook") {
    throw new Error("TELEGRAM_WEBHOOK_URL must be an https URL ending with /telegram/webhook");
  }

  if (url.host !== allowedHost) {
    throw new Error("TELEGRAM_WEBHOOK_URL host must match TELEGRAM_WEBHOOK_ALLOWED_HOST");
  }
}

function requireCleanGitTree(): void {
  const insideWorkTree = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--is-inside-work-tree"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (insideWorkTree.exitCode !== 0) {
    return;
  }

  const status = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    stdout: "pipe",
    stderr: "inherit",
  });
  if (status.exitCode !== 0) {
    throw new Error("Could not inspect git status before Telegram webhook mutation");
  }

  const dirtyStatus = new TextDecoder().decode(status.stdout).trim();
  if (dirtyStatus) {
    throw new Error(
      "Refusing Telegram webhook mutation from a dirty git tree. Commit the reviewed tree first.",
    );
  }
}

export {};
