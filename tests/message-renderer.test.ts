import { describe, expect, it, vi } from "vitest";

import { TelegramApi } from "../src/telegram/api.js";
import { normalizeUpdate } from "../src/telegram/update-normalizer.js";
import { chunkTelegramMessage } from "../src/telegram/message-renderer.js";
import { renderErrorMessage, renderWorkingMessage } from "../src/telegram/message-renderer.js";

describe("chunkTelegramMessage", () => {
  it("splits long messages into fixed-size chunks", () => {
    const message = "a".repeat(5000);

    const chunks = chunkTelegramMessage(message, 4000);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4000);
    expect(chunks[1]).toHaveLength(1000);
  });

  it("rejects non-positive limits", () => {
    expect(() => chunkTelegramMessage("hello", 0)).toThrow(RangeError);
  });

  it("rejects invalid numeric limits", () => {
    expect(() => chunkTelegramMessage("hello", Number.NaN)).toThrow(RangeError);
    expect(() => chunkTelegramMessage("hello", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => chunkTelegramMessage("hello", 3.5)).toThrow(RangeError);
  });
});

describe("message rendering", () => {
  it("renders the working message", () => {
    expect(renderWorkingMessage()).toBe("Working...");
  });

  it("renders error messages", () => {
    expect(renderErrorMessage("boom")).toBe("Error: boom");
  });
});

describe("normalizeUpdate", () => {
  it("normalizes a message update", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123 },
          from: { id: 456 },
          text: "hello",
        },
      }),
    ).toEqual({ chatId: 123, userId: 456, text: "hello" });
  });

  it("returns null when required fields are missing", () => {
    expect(normalizeUpdate({})).toBeNull();
  });
});

describe("TelegramApi", () => {
  it("throws a stable error for non-OK responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ ok: false }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API request failed for sendMessage: 500 Internal Server Error",
    );

    fetchMock.mockRestore();
  });

  it("throws for ok-false API payloads", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: false, description: "bad request" }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API request failed for sendMessage: bad request",
    );

    fetchMock.mockRestore();
  });

  it("throws a stable error for malformed JSON responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.editMessage(1, 2, "hello")).rejects.toThrow(
      "Telegram API response was not valid JSON for editMessageText",
    );

    fetchMock.mockRestore();
  });
});
