import { describe, expect, it } from "vitest";

import { chunkTelegramMessage } from "../src/telegram/message-renderer.js";

describe("chunkTelegramMessage", () => {
  it("splits long messages into fixed-size chunks", () => {
    const message = "a".repeat(5000);

    const chunks = chunkTelegramMessage(message, 4000);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(1000);
  });
});
