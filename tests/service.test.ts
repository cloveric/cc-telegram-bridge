import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createServiceDependenciesForInstance,
  parseServiceInstanceName,
  pollTelegramUpdatesOnce,
  processTelegramUpdates,
  readInstanceBotTokenFromEnvFile,
} from "../src/service.js";

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
        .mockResolvedValueOnce(undefined),
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
      bridge as never,
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

    await expect(pollTelegramUpdatesOnce(api as never, bridge as never, logger, 7)).resolves.toBe(7);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });
});
