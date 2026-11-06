import { webhookCallback } from "grammy";
import { createCommunityBot } from "./bot";
import {
  type ChannelJoinJob,
  type ChannelProfileJob,
  createChannelJoinMonitor,
} from "./channel-join-monitor";
import { processVibeNotificationDeleteQueue } from "./vibe-notification-delete";
import type { WorkerEnv } from "./types";
import type { VibeNotificationDeleteJob } from "./vibe-notification-delete";

type QueueJob = VibeNotificationDeleteJob | ChannelJoinJob | ChannelProfileJob;

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

  async queue(batch: MessageBatch<QueueJob>, env: WorkerEnv): Promise<void> {
    const channelJoins = batch.messages.filter(isChannelJoinMessage);
    const channelProfiles = batch.messages.filter(isChannelProfileMessage);
    if (channelJoins.length > 0 || channelProfiles.length > 0) {
      const monitor = createChannelJoinMonitor(env);
      await monitor.processJoins(channelJoins);
      await monitor.processProfiles(channelProfiles);
    }

    await processVibeNotificationDeleteQueue(
      batch.messages.filter(isVibeNotificationDeleteMessage),
      env,
    );
  },
};

function isChannelJoinMessage(message: Message<QueueJob>): message is Message<ChannelJoinJob> {
  return "type" in message.body && message.body.type === "channel_join";
}

function isChannelProfileMessage(
  message: Message<QueueJob>,
): message is Message<ChannelProfileJob> {
  return "type" in message.body && message.body.type === "channel_profile";
}

function isVibeNotificationDeleteMessage(
  message: Message<QueueJob>,
): message is Message<VibeNotificationDeleteJob> {
  return !("type" in message.body);
}
