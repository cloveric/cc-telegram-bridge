import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TelegramApi } from "../src/telegram/api.js";
import { normalizeUpdate } from "../src/telegram/update-normalizer.js";
import {
  chunkTelegramMessage,
  renderAccessCheckMessage,
  renderAttachmentDownloadMessage,
  renderErrorMessage,
  renderExecutionMessage,
  renderPairingMessage,
  renderPrivateChatRequiredMessage,
  renderUnauthorizedMessage,
  renderWorkingMessage,
} from "../src/telegram/message-renderer.js";

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
    expect(renderWorkingMessage()).toBe("Received. Starting your Codex session...");
  });

  it("renders error messages", () => {
    expect(renderErrorMessage("boom")).toBe("Error: boom");
  });

  it("renders progress and access messages", () => {
    expect(renderAccessCheckMessage()).toBe("Checking access policy...");
    expect(renderAttachmentDownloadMessage(1)).toBe("Downloading 1 attachment...");
    expect(renderAttachmentDownloadMessage(2)).toBe("Downloading 2 attachments...");
    expect(renderExecutionMessage()).toBe("Running Codex on your request...");
    expect(renderUnauthorizedMessage()).toBe("This chat is not authorized for this instance.");
    expect(renderPrivateChatRequiredMessage()).toBe("This bot only accepts private chats.");
    expect(renderPairingMessage("ABC123")).toBe("Pair this private chat with code ABC123");
  });
});

describe("normalizeUpdate", () => {
  it("normalizes a message update", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "hello",
        },
      }),
    ).toEqual({ chatId: 123, userId: 456, chatType: "private", text: "hello", attachments: [] });
  });

  it("extracts a document attachment", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "hello",
          document: {
            file_id: "doc-file",
            file_name: "report.pdf",
          },
        },
      }),
    ).toEqual({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "hello",
      attachments: [
        {
          fileId: "doc-file",
          fileName: "report.pdf",
          kind: "document",
        },
      ],
    });
  });

  it("extracts the highest-resolution photo attachment", () => {
    expect(
      normalizeUpdate({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          photo: [
            { file_id: "small" },
            { file_id: "large" },
          ],
        },
      }),
    ).toEqual({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "",
      attachments: [
        {
          fileId: "large",
          kind: "photo",
        },
      ],
    });
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

  it("throws a stable error for ok-false payloads with malformed descriptions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: false, description: { detail: "x" } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API response had an unexpected shape for sendMessage",
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

  it("throws a stable error for parsed payloads with the wrong shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => null,
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(
      "Telegram API response had an unexpected shape for sendMessage",
    );

    fetchMock.mockRestore();
  });

  it("returns the result array from getUpdates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: [{ update_id: 7 }] }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getUpdates()).resolves.toEqual([{ update_id: 7 }]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getUpdates", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 30 }),
    }));

    fetchMock.mockRestore();
  });

  it("passes offset to getUpdates when provided", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: [] }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getUpdates(42)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getUpdates", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 30, offset: 42 }),
    }));

    fetchMock.mockRestore();
  });

  it("rejects malformed getUpdates results at the API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { update_id: 7 } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getUpdates()).rejects.toThrow(
      "Telegram API response had an unexpected result shape for getUpdates",
    );

    fetchMock.mockRestore();
  });

  it("returns typed message results from sendMessage and editMessage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: { message_id: 9, text: "working" } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: { message_id: 9, text: "done" } }),
      } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "working")).resolves.toEqual({ message_id: 9, text: "working" });
    await expect(api.editMessage(1, 9, "done")).resolves.toEqual({ message_id: 9, text: "done" });

    fetchMock.mockRestore();
  });

  it("rejects malformed message results at the API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: { message_id: "9" } }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, result: {} }),
      } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.sendMessage(1, "working")).rejects.toThrow(
      "Telegram API response had an unexpected result shape for sendMessage",
    );
    await expect(api.editMessage(1, 9, "done")).rejects.toThrow(
      "Telegram API response had an unexpected result shape for editMessageText",
    );

    fetchMock.mockRestore();
  });

  it("resolves getFile metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { file_id: "abc", file_path: "documents/file.pdf" } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getFile("abc")).resolves.toEqual({ file_id: "abc", file_path: "documents/file.pdf" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/bottoken/getFile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: "abc" }),
    });

    fetchMock.mockRestore();
  });

  it("rejects malformed getFile results at the API boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, result: { file_id: "abc", file_path: 42 } }),
    } as unknown as Response);

    const api = new TelegramApi("token");

    await expect(api.getFile("abc")).rejects.toThrow(
      "Telegram API response had an unexpected result shape for getFile",
    );

    fetchMock.mockRestore();
  });

  it("downloads a file to disk", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new TextEncoder().encode("file-bytes").buffer,
    } as unknown as Response);

    const api = new TelegramApi("token");
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-download-"));
    const destinationPath = path.join(root, "nested", "file.bin");

    try {
      await api.downloadFile("documents/file.bin", destinationPath);

      await expect(readFile(destinationPath, "utf8")).resolves.toBe("file-bytes");
      expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/file/bottoken/documents/file.bin");
    } finally {
      fetchMock.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
