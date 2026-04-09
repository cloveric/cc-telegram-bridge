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
          spawnDetached: (command, args, options) => {
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
            spawnDetached(command, args, options);
          },
          sleep: async () => {},
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Started instance "alpha" with pid 12345.']);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      expect(spawnDetached).toHaveBeenCalledWith(
        process.execPath,
        [path.join(REPO_ROOT, "dist", "src", "index.js"), "--instance", "alpha"],
        {
          cwd: REPO_ROOT,
          stdoutPath: path.join(stateDir, "service.stdout.log"),
          stderrPath: path.join(stateDir, "service.stderr.log"),
        },
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for a fresh lock before reporting a restart as started", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);
    let sleepCalls = 0;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 11111,
          token: "old-token",
          acquiredAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "start", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          spawnDetached: async () => {},
          sleep: async () => {
            sleepCalls += 1;
            if (sleepCalls === 2) {
              await writeFile(
                lockPath,
                JSON.stringify({
                  pid: 22222,
                  token: "new-token",
                  acquiredAt: new Date().toISOString(),
                }),
                "utf8",
              );
            }
          },
          isProcessAlive: (pid) => pid === 22222,
          isExpectedServiceProcess: (pid) => pid === 11111 || pid === 22222,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Started instance "alpha" with pid 22222.']);
      expect(sleepCalls).toBeGreaterThan(0);
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
      expect(messages[0]).toContain("Engine: codex");
      expect(messages[0]).toContain("Runtime: process");
      expect(messages[0]).toContain("Allowlist count: 0");
      expect(messages[0]).toContain("Pending pair count: 0");
      expect(messages[0]).toContain("Session bindings: 0");
      expect(messages[0]).toContain("Audit events: 0");
      expect(messages[0]).toContain("Last success: none");
      expect(messages[0]).toContain("Last failure: none");
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
      expect(messages[0]).toContain("Engine: codex");
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
      expect(messages[0]).toContain("Runtime: process");
      expect(messages[0]).toContain("Bot identity lookup failed: temporary Telegram failure");
      expect(messages[0]).toContain("State dir:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns tailed service logs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];

    try {
      const handled = await runCli(["telegram", "service", "logs", "--instance", "alpha", "2"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          readTextFile: async (filePath: string) =>
            filePath.endsWith("stdout.log") ? "line-1\nline-2\nline-3\n" : "err-1\nerr-2\nerr-3\n",
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("--- stdout ---");
      expect(messages[0]).not.toContain("line-1");
      expect(messages[0]).toContain("line-2");
      expect(messages[0]).toContain("line-3");
      expect(messages[0]).toContain("--- stderr ---");
      expect(messages[0]).not.toContain("err-1");
      expect(messages[0]).toContain("err-2");
      expect(messages[0]).toContain("err-3");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs service doctor with a health summary", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 12345,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
      );
      await writeFile(
        path.join(stateDir, "audit.log.jsonl"),
        [
          '{"timestamp":"2026-04-08T10:00:00.000Z","type":"update.handle","outcome":"success"}',
          '{"timestamp":"2026-04-08T10:01:00.000Z","type":"update.handle","outcome":"error"}',
        ].join("\n") + "\n",
        "utf8",
      );

      const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: (pid) => pid === 12345,
          fetchTelegramBotIdentity: async () => ({ firstName: "Channel Bot", username: "channel_bot" }),
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Healthy: yes");
      expect(messages[0]).toContain("ok build:");
      expect(messages[0]).toContain("ok token:");
      expect(messages[0]).toContain("ok service:");
      expect(messages[0]).toContain("ok identity:");
      expect(messages[0]).toContain("ok audit:");
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
          isProcessAlive: (() => {
            let calls = 0;
            return (pid: number) => {
              calls += 1;
              return pid === 54321 && calls < 2;
            };
          })(),
          isExpectedServiceProcess: (pid) => pid === 54321,
          sleep: async () => {},
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

  it("restarts an instance by stopping and then starting it", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "default");
    const lockPath = resolveInstanceLockPath(stateDir);
    const killProcessTree = vi.fn();
    const spawnDetached = vi.fn();
    let started = false;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 54321,
          token: "token",
          acquiredAt: new Date().toISOString(),
        }),
      );

      const handled = await runCli(["telegram", "service", "restart"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => {
            if (pid === 54321) {
              return killProcessTree.mock.calls.length === 0;
            }

            return pid === 12345 && started;
          },
          isExpectedServiceProcess: (pid) => pid === 54321 || (pid === 12345 && started),
          killProcessTree,
          spawnDetached: (command, args, options) => {
            started = true;
            mkdir(stateDir, { recursive: true }).then(() =>
              writeFile(
                lockPath,
                JSON.stringify({
                  pid: 12345,
                  token: "token-2",
                  acquiredAt: new Date().toISOString(),
                }),
                "utf8",
              ),
            );
            spawnDetached(command, args, options);
          },
          sleep: async () => {},
        },
      });

      expect(handled).toBe(true);
      expect(killProcessTree).toHaveBeenCalledWith(54321);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
      expect(messages).toEqual(['Started instance "default" with pid 12345.']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
