import { describe, expect, test } from "bun:test";
import worker from "./index";
import { createTestEnv, installTelegramFetchMock } from "./__tests__/helpers";
import type { VibeNotificationDeleteJob } from "./vibe-notification-delete";

describe("worker fetch handler", () => {
  test("returns health without bot secrets", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/health"),
      { DB: {} as D1Database } as ReturnType<typeof createTestEnv>,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "telegram-bot",
    });
  });

  test("rejects webhook requests without configured secrets", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/telegram/webhook", { method: "POST" }),
      { DB: {} as D1Database } as ReturnType<typeof createTestEnv>,
    );

    expect(response.status).toBe(500);
  });

  test("rejects webhook requests with a wrong Telegram secret token", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
      }),
      createTestEnv(),
    );

    expect(response.status).toBe(401);
  });

  test("deletes queued vibe notification messages", async () => {
    const fetchMock = installTelegramFetchMock();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock.fetch;

    try {
      await worker.queue(
        queueBatch([{ chatId: -1001, messageId: 42 }]),
        createTestEnv(),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock.requests).toHaveLength(1);
    expect(fetchMock.requests[0]?.url).toEndWith("/deleteMessage");
    expect(fetchMock.requests[0]?.body).toMatchObject({
      chat_id: -1001,
      message_id: 42,
    });
  });

  test("does not retry queued deletes when Telegram says the message is already gone", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return Response.json(
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message to delete not found",
        },
        { status: 400 },
      );
    }) as unknown as typeof fetch;

    try {
      await expect(
        worker.queue(
          queueBatch([{ chatId: -1001, messageId: 42 }]),
          createTestEnv(),
        ),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function queueBatch(
  jobs: readonly VibeNotificationDeleteJob[],
): MessageBatch<VibeNotificationDeleteJob> {
  return {
    queue: "vibecoding-community-bot-prod-vibe-notification-deletes",
    messages: jobs.map((body, index) => {
      return {
        id: `message-${index}`,
        timestamp: new Date(0),
        body,
        attempts: 1,
        ack() {},
        retry() {},
      };
    }),
    metadata: {
      metrics: {
        batchSize: jobs.length,
        retries: 0,
      } as unknown as MessageBatchMetrics,
    },
    ackAll() {},
    retryAll() {},
  };
}
