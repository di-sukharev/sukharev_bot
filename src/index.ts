import { webhookCallback } from "grammy";
import { createCommunityBot } from "./bot";
import { processVibeNotificationDeleteQueue } from "./vibe-notification-delete";
import type { WorkerEnv } from "./types";
import type { VibeNotificationDeleteJob } from "./vibe-notification-delete";

const WEBHOOK_PATH = "/telegram/webhook";

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "telegram-bot" });
    }

    if (url.pathname !== WEBHOOK_PATH) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    if (!env.BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Bot secrets are not configured", { status: 500 });
    }

    const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (actualSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const bot = createCommunityBot(env, {
      notificationDelete: ctx
        ? {
            scheduleTask: (task) => ctx.waitUntil(task),
          }
        : undefined,
    });
    return webhookCallback(bot, "cloudflare-mod")(request);
  },

  async queue(
    batch: MessageBatch<VibeNotificationDeleteJob>,
    env: WorkerEnv,
  ): Promise<void> {
    await processVibeNotificationDeleteQueue(batch, env);
  },
};
