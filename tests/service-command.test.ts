import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/commands/cli.js";
import { resolveInstanceLockPath } from "../src/state/instance-lock.js";

const REPO_ROOT = "C:\\Users\\hangw\\codex-telegram-channel";

describe("telegram service commands", () => {
  it("starts a named instance through the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const spawnDetached = vi.fn();
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      const handled = await runCli(["telegram", "service", "start", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          spawnDetached: (command, args) => {
            mkdir(stateDir, { recursive: true }).then(() =>
              writeFile(
                lockPath,
                JSON.stringify({
                  pid: 12345,
                  token: "token",
                  acquiredAt: new Date().toISOString(),
                }),
                "utf8",
              ),
            );
            spawnDetached(command, args);
          },
          sleep: async () => {},
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Started instance "alpha" with pid 12345.']);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports service status without a configured token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
      );

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Running: yes");
      expect(messages[0]).toContain("Pid: 12345");
      expect(messages[0]).toContain("Allowlist count: 0");
      expect(messages[0]).toContain("Pending pair count: 0");
      expect(messages[0]).toContain("Lock path:");
      expect(messages[0]).toContain("Bot token configured: no");
      expect(messages[0]).not.toContain("Bot identity:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a configured token and bot identity when lookup succeeds", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          fetchTelegramBotIdentity: async () => ({ firstName: "Channel Bot", username: "channel_bot" }),
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Bot token configured: yes");
      expect(messages[0]).toContain("Bot identity: Channel Bot (@channel_bot)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps status usable when bot identity lookup fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          fetchTelegramBotIdentity: async () => {
            throw new Error("temporary Telegram failure");
          },
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Bot token configured: yes");
      expect(messages[0]).toContain("Bot identity lookup failed: temporary Telegram failure");
      expect(messages[0]).toContain("State dir:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stops a running instance through the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "default");
    const lockPath = resolveInstanceLockPath(stateDir);
    const killProcessTree = vi.fn();

    try {
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(stateDir, { recursive: true }).then(() =>
          fs.writeFile(
            lockPath,
            JSON.stringify({
              pid: 54321,
              token: "token",
              acquiredAt: new Date().toISOString(),
            }),
          ),
        ),
      );

      const handled = await runCli(["telegram", "service", "stop"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          isProcessAlive: (pid) => pid === 54321,
          isExpectedServiceProcess: (pid) => pid === 54321,
          killProcessTree,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Stopped instance "default".']);
      expect(killProcessTree).toHaveBeenCalledWith(54321);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
