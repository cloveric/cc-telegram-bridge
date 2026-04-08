import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AccessStore } from "../src/state/access-store.js";
import { runCli } from "../src/commands/cli.js";
import { SessionStore } from "../src/state/session-store.js";

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
    await expect(runCli(["ping"], { env: { USERPROFILE: "C:\\Users\\hangw" } })).resolves.toBe(false);
  });

  it("rejects unexpected positional args for status", async () => {
    await expect(
      runCli(["telegram", "status", "extra"], {
        env: { USERPROFILE: "C:\\Users\\hangw" },
      }),
    ).rejects.toThrow("Usage: telegram status [--instance <name>]");
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

  it("redeems a pairing code for the default instance and rejects invalid codes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const accessPath = path.join(tempDir, ".codex", "channels", "telegram", "default", "access.json");
      const store = new AccessStore(accessPath);
      const issuedAt = new Date();
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: issuedAt,
      });

      const handled = await runCli(["telegram", "access", "pair", issued.code], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Redeemed pairing code for instance "default" and chat 84.']);
      expect((await store.getStatus()).pairedUsers).toBe(1);

      await expect(
        runCli(["telegram", "access", "pair", "ZZZZZZ"], {
          env: { USERPROFILE: tempDir },
        }),
      ).rejects.toThrow('Pairing code "ZZZZZZ" is invalid or expired.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports named-instance access policy, allow, revoke, and status commands", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const accessPath = path.join(tempDir, ".codex", "channels", "telegram", "alpha", "access.json");
      const store = new AccessStore(accessPath);
      await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      await runCli(["telegram", "access", "policy", "--instance", "alpha", "allowlist"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "access", "allow", "--instance", "alpha", "123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "access", "revoke", "--instance", "alpha", "123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "access", "allow", "--instance", "alpha", "123"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      await runCli(["telegram", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: {
          log: (message) => messages.push(message),
        },
      });

      expect(messages.slice(0, 4)).toEqual([
        'Updated access policy for instance "alpha" to "allowlist".',
        'Allowed chat 123 for instance "alpha".',
        'Revoked chat 123 for instance "alpha".',
        'Allowed chat 123 for instance "alpha".',
      ]);
      expect(messages[4]).toMatch(
        /^Instance: alpha\nPolicy: allowlist\nPaired users: 0\nAllowlist: 123\nPending pairs: [A-Z2-9]{6} chat 84 expires 2026-04-08T00:05:00\.000Z$/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists and shows session bindings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const sessionPath = path.join(tempDir, ".codex", "channels", "telegram", "default", "session.json");
      const store = new SessionStore(sessionPath);
      await store.upsert({
        telegramChatId: 84,
        codexSessionId: "thread-abc",
        status: "idle",
        updatedAt: "2026-04-08T12:00:00.000Z",
      });

      await runCli(["telegram", "session", "list"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      await runCli(["telegram", "session", "show", "84"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
      });

      expect(messages[0]).toContain("Session bindings: 1");
      expect(messages[0]).toContain("chat 84 -> thread-abc");
      expect(messages[1]).toContain("Thread: thread-abc");
      expect(messages[1]).toContain("Status: idle");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
