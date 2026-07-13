export const VIBE_NOTIFICATION_DELETE_DELAY_SECONDS = 5;
export const WELCOME_MESSAGE_DELETE_DELAY_SECONDS = 15;

export type VibeNotificationDeleteJob = {
  chatId: number | string;
  messageId: number;
};

type VibeNotificationDeleteEnv = {
  BOT_TOKEN?: string;
  VIBE_NOTIFICATION_DELETE_QUEUE?: Queue<VibeNotificationDeleteJob>;
};

type TelegramDeleteMessageEnv = {
  BOT_TOKEN?: string;
};

export type VibeNotificationDeleteOptions = {
  apiFetch?: typeof fetch;
  delayMs?: number;
  delaySeconds?: number;
  scheduleTask?: (task: Promise<void>) => void;
};

export async function scheduleVibeNotificationDelete(
  env: VibeNotificationDeleteEnv,
  job: VibeNotificationDeleteJob,
  options: VibeNotificationDeleteOptions = {},
): Promise<void> {
  const delaySeconds =
    options.delaySeconds ?? VIBE_NOTIFICATION_DELETE_DELAY_SECONDS;

  if (options.scheduleTask) {
    options.scheduleTask(
      deleteTelegramMessageAfterDelay(
        env,
        job,
        options.apiFetch ?? fetch,
        options.delayMs ?? delaySeconds * 1000,
      ).catch((error) => {
        console.error("Failed to delete delayed vibe notification", {
          chatId: job.chatId,
          messageId: job.messageId,
          error,
        });
      }),
    );
    return;
  }

  if (!env.VIBE_NOTIFICATION_DELETE_QUEUE) {
    return;
  }

  try {
    await env.VIBE_NOTIFICATION_DELETE_QUEUE.send(job, {
      delaySeconds,
    });
  } catch (error) {
    console.error("Failed to queue vibe notification delete", {
      chatId: job.chatId,
      messageId: job.messageId,
      error,
    });
  }
}

async function deleteTelegramMessageAfterDelay(
  env: TelegramDeleteMessageEnv,
  job: VibeNotificationDeleteJob,
  apiFetch: typeof fetch,
  delayMs: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await deleteTelegramMessage(env, job, apiFetch);
}

export async function processVibeNotificationDeleteQueue(
  batch: MessageBatch<VibeNotificationDeleteJob>,
  env: TelegramDeleteMessageEnv,
  apiFetch: typeof fetch = fetch,
): Promise<void> {
  for (const message of batch.messages) {
    await deleteTelegramMessage(env, message.body, apiFetch);
  }
}

async function deleteTelegramMessage(
  env: TelegramDeleteMessageEnv,
  job: VibeNotificationDeleteJob,
  apiFetch: typeof fetch,
): Promise<void> {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is required to delete queued vibe notifications");
  }

  const response = await apiFetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: job.chatId,
        message_id: job.messageId,
      }),
    },
  );
  const result = await response.json().catch(() => null);

  if (response.ok && isTelegramOk(result)) {
    return;
  }

  if (isIgnorableDeleteError(result)) {
    return;
  }

  throw new Error(`Telegram deleteMessage failed: ${JSON.stringify(result)}`);
}

function isTelegramOk(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === "object" && "ok" in result && result.ok);
}

function isIgnorableDeleteError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }

  const error = result as { error_code?: number; description?: string };
  if (error.error_code !== 400 || !error.description) {
    return false;
  }

  const description = error.description.toLowerCase();
  return (
    description.includes("message to delete not found") ||
    description.includes("message can't be deleted") ||
    description.includes("message cannot be deleted")
  );
}
