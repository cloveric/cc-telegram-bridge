import { describe, expect, it } from "vitest";

import { ChatQueue } from "../src/runtime/chat-queue.js";

describe("ChatQueue", () => {
  it("serializes jobs per chat", async () => {
    const queue = new ChatQueue();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue(1, async () => {
        events.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push("end-1");
      }),
      queue.enqueue(1, async () => {
        events.push("start-2");
        events.push("end-2");
      }),
    ]);

    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});
