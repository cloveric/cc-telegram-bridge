import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createServiceDependenciesForInstance,
  handleNormalizedTelegramMessage,
  parseServiceInstanceName,
  pollTelegramUpdatesOnce,
  processTelegramUpdates,
  readInstanceBotTokenFromEnvFile,
} from "../src/service.js";
import { renderErrorMessage, renderWorkingMessage } from "../src/telegram/message-renderer.js";

describe("parseServiceInstanceName", () => {
  it("defaults to the default instance", () => {
    expect(parseServiceInstanceName([])).toBe("default");
  });

  it("reads a named instance from --instance", () => {
    expect(parseServiceInstanceName(["--instance", "alpha"])).toBe("alpha");
  });

  it("reads a named instance from --instance=", () => {
    expect(parseServiceInstanceName(["--instance=beta"])).toBe("beta");
  });
});

describe("readInstanceBotTokenFromEnvFile", () => {
  it("reads TELEGRAM_BOT_TOKEN from the instance .env file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".codex", "channels", "telegram", "alpha", ".env");

    try {
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      await expect(
        readInstanceBotTokenFromEnvFile({
          USERPROFILE: root,
          CODEX_TELEGRAM_INSTANCE: "alpha",
        }),
      ).resolves.toBe("secret-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createServiceDependenciesForInstance", () => {
  it("does not mutate process.env.TELEGRAM_BOT_TOKEN directly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".codex", "channels", "telegram", "alpha", ".env");
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;

    try {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      expect(result.config.telegramBotToken).toBe("secret-token");
      expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    } finally {
      if (originalToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      }

      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("polling helpers", () => {
  it("continues processing later updates when one handler throws", async () => {
    const logger = {
      error: vi.fn(),
    };
    const bridge = {
      handleAuthorizedMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ text: "second result" }),
    };

    await processTelegramUpdates(
      [
        {
          message: {
            chat: { id: 123 },
            from: { id: 456 },
            text: "first",
          },
        },
        {
          message: {
            chat: { id: 123 },
            from: { id: 456 },
            text: "second",
          },
        },
      ],
      {
        api: {
          sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
          editMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        } as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
      logger,
    );

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("logs getUpdates failures without crashing the loop helper", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("temporary failure")),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn(),
    };

    await expect(pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7)).resolves.toBe(7);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });

  it("downloads attachments and passes local file paths to the bridge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi
        .fn()
        .mockResolvedValueOnce({ file_path: "docs/report.pdf" })
        .mockResolvedValueOnce({ file_path: "photos/pic.jpg" }),
      downloadFile: vi
        .fn()
        .mockImplementation(async (_filePath: string, destinationPath: string) => await writeFile(destinationPath, "x")),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          text: "hello",
          attachments: [
            { fileId: "doc-1", fileName: "report.pdf", kind: "document" },
            { fileId: "photo-1", kind: "photo" },
          ],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.getFile).toHaveBeenCalledTimes(2);
      expect(api.downloadFile).toHaveBeenCalledTimes(2);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith({
        chatId: 123,
        userId: 456,
        text: "hello",
        files: [
          path.join(inboxDir, "doc-1-report.pdf"),
          path.join(inboxDir, "photo-1.jpg"),
        ],
      });
      await expect(readFile(path.join(inboxDir, "doc-1-report.pdf"), "utf8")).resolves.toBe("x");
      await expect(readFile(path.join(inboxDir, "photo-1.jpg"), "utf8")).resolves.toBe("x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends a placeholder message and edits it on success", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "final response" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        text: "hello",
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(api.sendMessage).toHaveBeenCalledWith(123, renderWorkingMessage());
    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "final response");
  });

  it("edits the placeholder to an error message when the bridge throws", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(
      handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          text: "hello",
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir: path.join(os.tmpdir(), "ignored"),
        },
      ),
    ).rejects.toThrow("boom");

    expect(api.editMessage).toHaveBeenCalledWith(123, 11, renderErrorMessage("boom"));
  });

  it("chunks long responses by editing the placeholder with the first chunk and sending the rest", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "a".repeat(4500) }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        text: "hello",
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(api.editMessage).toHaveBeenCalledWith(123, 11, "a".repeat(4000));
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(500));
  });
});
