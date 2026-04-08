import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/commands/cli.js";

describe("runCli", () => {
  it("configures the default instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "configure", "bot-token-123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Configured Telegram bot token for instance "default".']);

      const envPath = path.join(tempDir, ".codex", "channels", "telegram", "default", ".env");
      await expect(readFile(envPath, "utf8")).resolves.toBe('TELEGRAM_BOT_TOKEN="bot-token-123"\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("configures a named instance", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "configure", "--instance", "alpha", "bot-token-456"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Configured Telegram bot token for instance "alpha".']);

      const envPath = path.join(tempDir, ".codex", "channels", "telegram", "alpha", ".env");
      await expect(readFile(envPath, "utf8")).resolves.toBe('TELEGRAM_BOT_TOKEN="bot-token-456"\n');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid instance name", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await expect(
        runCli(["telegram", "configure", "--instance", "..\\..\\x", "bot-token-456"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toThrow("Invalid instance name");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects missing configure token", async () => {
    await expect(runCli(["telegram", "configure"], { env: { USERPROFILE: "C:\\Users\\hangw" } })).rejects.toThrow(
      "Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>",
    );
  });

  it("returns false for non-CLI invocation", async () => {
    await expect(runCli(["status"], { env: { USERPROFILE: "C:\\Users\\hangw" } })).resolves.toBe(false);
  });

  it("updates an existing .env file instead of replacing unrelated lines", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const envPath = path.join(tempDir, ".codex", "channels", "telegram", "default", ".env");
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, "EXTRA=1\nTELEGRAM_BOT_TOKEN=old-token\nKEEP=2\n", "utf8");

      await runCli(["telegram", "configure", "new-token"], {
        env: { USERPROFILE: tempDir },
      });

      await expect(readFile(envPath, "utf8")).resolves.toBe("EXTRA=1\nKEEP=2\nTELEGRAM_BOT_TOKEN=\"new-token\"\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
