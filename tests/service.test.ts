import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createServiceDependenciesForInstance,
  parseServiceInstanceName,
  pollTelegramUpdatesOnce,
  pollTelegramUpdates,
  processTelegramUpdates,
  readInstanceBotTokenFromEnvFile,
} from "../src/service.js";
import { ChatQueue } from "../src/runtime/chat-queue.js";
import { handleNormalizedTelegramMessage } from "../src/telegram/delivery.js";
import { normalizeUpdate } from "../src/telegram/update-normalizer.js";
import { renderErrorMessage, renderWorkingMessage } from "../src/telegram/message-renderer.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Condition was not met in time");
}

function createZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(contents, "utf8"));
  }

  return zip.toBuffer();
}

afterEach(async () => {
  await rm(path.join(os.tmpdir(), "ignored"), { recursive: true, force: true });
  await rm(path.join(os.tmpdir(), "runtime-state.json"), { force: true });
});

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

  it("uses the persistent Codex app-server adapter by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".codex", "channels", "telegram", "alpha", ".env");

    try {
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter).toBeInstanceOf(ProcessCodexAdapter);
      expect((result.bridge as any).adapter.childEnv.CODEX_HOME).toBe(
        path.join(root, ".codex", "channels", "telegram", "alpha", "engine-home"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies shared Codex auth files into the isolated engine home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");
    const authPath = path.join(root, ".codex", "auth.json");
    const configTomlPath = path.join(root, ".codex", "config.toml");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(authPath, '{"access_token":"shared-token"}\n', "utf8");
      await writeFile(configTomlPath, 'model = "gpt-5.3-codex"\n', "utf8");

      await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      await expect(readFile(path.join(stateDir, "engine-home", "auth.json"), "utf8")).resolves.toBe(
        '{"access_token":"shared-token"}\n',
      );
      await expect(readFile(path.join(stateDir, "engine-home", "config.toml"), "utf8")).resolves.toBe(
        'model = "gpt-5.3-codex"\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the process adapter when codex yolo mode is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CODEX_EXECUTABLE: "codex",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter).toBeInstanceOf(ProcessCodexAdapter);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the Claude adapter when the instance engine is claude", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");

      const result = await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CLAUDE_EXECUTABLE: "claude",
        },
        "alpha",
      );

      expect((result.bridge as any).adapter).toBeInstanceOf(ClaudeStreamAdapter);
      expect((result.bridge as any).adapter.childEnv.CLAUDE_CONFIG_DIR).toBe(
        path.join(root, ".codex", "channels", "telegram", "alpha", "engine-home"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies shared Claude auth files into the isolated engine home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".codex", "channels", "telegram", "alpha");
    const envPath = path.join(stateDir, ".env");
    const configPath = path.join(stateDir, "config.json");
    const globalClaudeDir = path.join(root, ".claude");
    const globalClaudeCredentialsPath = path.join(globalClaudeDir, ".credentials.json");
    const globalClaudeJsonPath = path.join(root, ".claude.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(globalClaudeDir, { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");
      await writeFile(globalClaudeCredentialsPath, '{"claudeAiOauth":{"accessToken":"shared-token"}}\n', "utf8");
      await writeFile(globalClaudeJsonPath, '{"projects":{}}\n', "utf8");

      await createServiceDependenciesForInstance(
        {
          USERPROFILE: root,
          CLAUDE_EXECUTABLE: "claude",
        },
        "alpha",
      );

      await expect(readFile(path.join(stateDir, "engine-home", ".credentials.json"), "utf8")).resolves.toBe(
        '{"claudeAiOauth":{"accessToken":"shared-token"}}\n',
      );
      await expect(readFile(path.join(stateDir, "engine-home", ".claude.json"), "utf8")).resolves.toBe(
        '{"projects":{}}\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("polling helpers", () => {
  it("processes the same Telegram update only once across repeated polls", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      const update = {
        update_id: 42,
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 456 },
          text: "hello",
        },
      };

      await processTelegramUpdates(
        [update],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );
      await processTelegramUpdates(
        [update],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips updates whose update_id is lower than or equal to the last handled update", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await processTelegramUpdates(
        [
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "first",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      await processTelegramUpdates(
        [
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "duplicate",
            },
          },
          {
            update_id: 9,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "older",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps processing increasing update ids", async () => {
    const logger = {
      error: vi.fn(),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await processTelegramUpdates(
        [
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "first",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      await processTelegramUpdates(
        [
          {
            update_id: 11,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "second",
            },
          },
          {
            update_id: 12,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "third",
            },
          },
        ],
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
        logger,
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(3);
      expect(api.sendMessage).toHaveBeenCalledTimes(3);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not advance offset beyond a failed update", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi.fn().mockResolvedValue([
        {
          update_id: 10,
          message: {
            chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "first",
          },
        },
        {
          update_id: 11,
          message: {
            chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "second",
          },
        },
      ]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi
        .fn()
        .mockResolvedValueOnce({ text: "first result" })
        .mockRejectedValueOnce(new Error("boom")),
    };

    await expect(
      pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
    ).resolves.toEqual({
      offset: 11,
      hadFetchError: false,
      hadUpdates: true,
      conflict: false,
    });

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("stops processing later updates after a failed update", async () => {
    const logger = {
      error: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ text: "second result" }),
    };

    await processTelegramUpdates(
      [
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "first",
          },
        },
        {
          message: {
              chat: { id: 123, type: "private" },
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

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
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
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    await expect(
      pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
    ).resolves.toEqual({
      offset: 7,
      hadFetchError: true,
      hadUpdates: false,
      conflict: false,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });

  it("treats aborted polling as a clean shutdown instead of a fetch failure", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi.fn().mockRejectedValue(new Error("Telegram API request aborted")),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    await expect(
      pollTelegramUpdatesOnce(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, 7),
    ).resolves.toEqual({
      offset: 7,
      hadFetchError: false,
      hadUpdates: false,
      conflict: false,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not enter immediate retry when updates failed before offset advanced", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      getUpdates: vi
        .fn()
        .mockResolvedValueOnce([
          {
            update_id: 10,
            message: {
              chat: { id: 123, type: "private" },
              from: { id: 456 },
              text: "first",
            },
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const sleepCalls: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    try {
      const controller = new AbortController();
      let pollCount = 0;
      globalThis.setTimeout = (((handler: TimerHandler, timeout?: number) => {
        sleepCalls.push(Number(timeout ?? 0));
        if (typeof handler === "function") {
          queueMicrotask(() => handler());
        }
        pollCount += 1;
        if (pollCount >= 2) {
          controller.abort();
        }
        return {} as ReturnType<typeof setTimeout>;
      }) as unknown) as typeof setTimeout;

      await pollTelegramUpdates(api as never, bridge as never, path.join(os.tmpdir(), "ignored"), logger, controller.signal);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(sleepCalls[0]).toBe(100);
  });

  it("serializes same-chat updates through the service chat queue", async () => {
    const logger = {
      error: vi.fn(),
    };
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    };
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const releaseFirstCall = createDeferred<void>();
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ text }: { text: string }) => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);

        if (text === "first") {
          await releaseFirstCall.promise;
        }

        activeCalls -= 1;
        return { text: `${text} done` };
      }),
    };
    const chatQueue = new ChatQueue();
    const firstRun = processTelegramUpdates(
      [
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "first",
          },
        },
      ],
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
        chatQueue,
      },
      logger,
    );
    const secondRun = processTelegramUpdates(
      [
        {
          message: {
              chat: { id: 123, type: "private" },
            from: { id: 456 },
            text: "second",
          },
        },
      ],
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
        chatQueue,
      },
      logger,
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(maxConcurrentCalls).toBe(1);

    releaseFirstCall.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
    expect(maxConcurrentCalls).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
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
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
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
      expect(api.editMessage).toHaveBeenNthCalledWith(1, 123, 11, "Checking access policy...");
      expect(api.editMessage).toHaveBeenNthCalledWith(2, 123, 11, "Downloading 2 attachments...");
      expect(api.editMessage).toHaveBeenNthCalledWith(3, 123, 11, "Working on your request...");
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: expect.stringContaining("hello"),
        replyContext: undefined,
        files: [
          expect.stringContaining(path.join("workspace", ".telegram-files")),
          expect.stringContaining(path.join("workspace", ".telegram-files")),
        ],
      }));
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain("[Document Extract]");
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain("[Image Uploads]");
      await expect(readFile(path.join(inboxDir, "doc-1-report.pdf"), "utf8")).resolves.toBe("x");
      await expect(readFile(path.join(inboxDir, "photo-1.jpg"), "utf8")).resolves.toBe("x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("summarizes uploaded zip archives and waits for continue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "package.json": '{"name":"demo"}',
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        expect.stringContaining("Reply \"继续分析\" or press the Continue Analysis button to continue with this archive."),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: expect.stringMatching(/^continue-archive:/) }]],
        }),
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string; status: string; kind: string; summary: string }>;
      };
      expect(workflowState.records).toHaveLength(1);
      expect(workflowState.records[0]?.kind).toBe("archive");
      expect(workflowState.records[0]?.status).toBe("awaiting_continue");
      expect(workflowState.records[0]?.summary).toContain("README.md");
      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        expect.stringContaining("press the Continue Analysis button"),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${workflowState.records[0]?.uploadId}` }]],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows a continue-analysis shortcut button after archive summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ uploadId: string }>;
      };

      expect(api.editMessage).toHaveBeenCalledWith(
        123,
        11,
        expect.stringContaining('Reply "继续分析"'),
        expect.objectContaining({
          inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${workflowState.records[0]?.uploadId}` }]],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a failed archive workflow record when extraction is rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/bad.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "not a zip archive", "utf8");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn(),
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(
          {
            chatId: 123,
            userId: 456,
            chatType: "private",
            text: "",
            replyContext: undefined,
            attachments: [{ fileId: "zip-1", fileName: "bad.zip", kind: "document" }],
          },
          {
            api: api as never,
            bridge: bridge as never,
            inboxDir,
          },
        ),
      ).rejects.toThrow();

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{
          uploadId: string;
          status: string;
          kind: string;
          sourceFiles: string[];
          extractedPath?: string;
          summary: string;
        }>;
      };

      expect(workflowState.records).toHaveLength(1);
      expect(workflowState.records[0]).toEqual(expect.objectContaining({
        kind: "archive",
        status: "failed",
        extractedPath: expect.stringContaining(path.join("workspace", ".telegram-files")),
        sourceFiles: [expect.stringContaining(path.join("workspace", ".telegram-files"))],
        summary: expect.stringMatching(/invalid|zip|archive/i),
      }));
      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        "Error: File handling failed while preparing your request. Retry with a smaller or different file.",
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues analysis for the latest uploaded archive when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "uploads/repo.zip" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, zipBuffer);
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "",
          replyContext: undefined,
          attachments: [{ fileId: "zip-1", fileName: "repo.zip", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "继续分析 看看结构",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 123,
          text: expect.stringContaining("[Archive Analysis Context]"),
          files: [],
        }),
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "看看结构",
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "Extracted files live under:",
      );

      const workflowState = JSON.parse(await readFile(path.join(root, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps archive-specific callback queries to the targeted /continue flow", async () => {
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 11, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:archive-1",
      },
    });

    expect(normalized).toEqual(expect.objectContaining({ text: "/continue --upload archive-1" }));
  });

  it("continues the archive selected by the clicked callback when multiple archives are waiting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "archive-1",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo.zip"],
            derivedFiles: [],
            summary: "archive summary one",
            extractedPath: "workspace/.telegram-files/archive-1/extracted",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            uploadId: "archive-2",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["repo-2.zip"],
            derivedFiles: [],
            summary: "archive summary two",
            extractedPath: "workspace/.telegram-files/archive-2/extracted",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "analysis done" }),
    };
    const normalized = normalizeUpdate({
      update_id: 99,
      callback_query: {
        id: "cb-1",
        from: { id: 456 },
        message: { message_id: 11, chat: { id: 123, type: "private" }, text: "Archive summary" },
        data: "continue-archive:archive-1",
      },
    });

    try {
      await handleNormalizedTelegramMessage(
        normalized!,
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb-1");
      expect(api.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(api.sendMessage.mock.invocationCallOrder[0]);
      expect(api.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(api.editMessage.mock.invocationCallOrder[0]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[Archive Analysis Context]"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary one"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("archive summary two"),
        }),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: "/continue" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects extracted text for supported document uploads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "docs/note.md" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "# Heading\nBody text");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "帮我总结",
          replyContext: undefined,
          attachments: [{ fileId: "doc-1", fileName: "note.md", kind: "document" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[Document Extract]"),
          files: expect.any(Array),
        }),
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "# Heading\nBody text",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages image uploads and forwards explicit image context to the bridge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn().mockResolvedValue({ file_path: "photos/screenshot.jpg" }),
      downloadFile: vi.fn().mockImplementation(async (_filePath: string, destinationPath: string) => {
        await writeFile(destinationPath, "img");
      }),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "看看这张图",
          replyContext: undefined,
          attachments: [{ fileId: "photo-1", kind: "photo" }],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[Image Uploads]"),
          files: [expect.stringContaining(path.join("workspace", ".telegram-files"))],
        }),
      );
      expect((bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text).toContain(
        "看看这张图",
      );
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
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "final response" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(api.sendMessage).toHaveBeenCalledWith(123, renderWorkingMessage());
    expect(api.editMessage).toHaveBeenNthCalledWith(1, 123, 11, "Checking access policy...");
    expect(api.editMessage).toHaveBeenNthCalledWith(2, 123, 11, "Working on your request...");
    expect(api.editMessage).toHaveBeenNthCalledWith(3, 123, 11, "final response");
  });

  it("waits for in-flight progress edits before applying the final response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const progressEdit = createDeferred<{ message_id: number }>();
    const progressStarted = createDeferred<void>();
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockImplementation(async (_chatId: number, _messageId: number, text: string) => {
        if (text === "partial progress") {
          progressStarted.resolve();
          return await progressEdit.promise;
        }

        return { message_id: 11 };
      }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ onProgress }: { onProgress?: (text: string) => void }) => {
        onProgress?.("partial progress");
        return { text: "final response" };
      }),
    };

    try {
      const pending = handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      await progressStarted.promise;
      expect(api.editMessage).toHaveBeenCalledWith(123, 11, "partial progress");
      expect(api.editMessage).not.toHaveBeenCalledWith(123, 11, "final response");

      progressEdit.resolve({ message_id: 11 });
      await pending;

      expect(api.editMessage).toHaveBeenCalledWith(123, 11, "final response");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resets only the current chat session when /reset is sent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            telegramChatId: 456,
            codexSessionId: "thread-keep",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(123, 11, "Session reset for this chat.");
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual({
        chats: [
          {
            telegramChatId: 456,
            codexSessionId: "thread-keep",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a concise status message for /status with blocking tasks called out separately", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-bound",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "file-workflow.json"),
      JSON.stringify({
        records: [
          {
            uploadId: "one",
            chatId: 123,
            userId: 456,
            kind: "document",
            status: "processing",
            sourceFiles: ["a.txt"],
            derivedFiles: [],
            summary: "first",
            createdAt: "2026-04-10T00:00:00.000Z",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
          {
            uploadId: "two",
            chatId: 123,
            userId: 456,
            kind: "archive",
            status: "awaiting_continue",
            sourceFiles: ["b.zip"],
            derivedFiles: [],
            summary: "second",
            createdAt: "2026-04-10T00:01:00.000Z",
            updatedAt: "2026-04-10T00:01:00.000Z",
          },
          {
            uploadId: "three",
            chatId: 123,
            userId: 456,
            kind: "document",
            status: "failed",
            sourceFiles: ["c.txt"],
            derivedFiles: [],
            summary: "third failed",
            createdAt: "2026-04-10T00:02:00.000Z",
            updatedAt: "2026-04-10T00:02:00.000Z",
          },
          {
            uploadId: "four",
            chatId: 123,
            userId: 456,
            kind: "document",
            status: "completed",
            sourceFiles: ["d.txt"],
            derivedFiles: [],
            summary: "fourth",
            createdAt: "2026-04-10T00:03:00.000Z",
            updatedAt: "2026-04-10T00:03:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/status",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        [
          "Engine: codex",
          "Session bound: yes",
          "Blocking file tasks: 2",
          "Waiting file tasks: 1",
        ].join("\n"),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("degrades /status when session and workflow state are unreadable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "session.json"), "{not valid json", "utf8");
    await writeFile(path.join(root, "file-workflow.json"), "{not valid json", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/status",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        [
          "Engine: codex",
          "Session bound: unknown (session state unreadable)",
          "Blocking file tasks: unknown (file workflow state unreadable)",
          "Waiting file tasks: unknown (file workflow state unreadable)",
        ].join("\n"),
      );
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns help text for /help", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/help",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        [
          "Telegram commands:",
          "/status - show engine, session, and file task state",
          "Send files directly to analyze them in chat.",
          "Archives pause after summary; reply \"继续分析\" or press Continue Analysis to keep going.",
          "/reset - clear the current chat session",
          "/help - show this help",
        ].join("\n"),
      );
      expect(api.editMessage).not.toHaveBeenCalledWith(123, 11, expect.stringContaining("/tasks"));
      expect(api.editMessage).not.toHaveBeenCalledWith(123, 11, expect.stringContaining("/continue"));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reset session state when /reset is denied by access control", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "deny", text: "This chat is not authorized for this instance." }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(123, 11, "This chat is not authorized for this instance.");
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs unreadable session state when /reset is sent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "session.json"), "{not valid json", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(
        123,
        11,
        "Session reset. Previous session state was unreadable, so it was repaired.",
      );
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual({ chats: [] });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reset session state when /reset is blocked by pairing access control", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(
      path.join(root, "session.json"),
      JSON.stringify({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "reply", text: "Pair this private chat with code ABC123" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "/reset",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(api.editMessage).toHaveBeenLastCalledWith(123, 11, "Pair this private chat with code ABC123");
      expect(JSON.parse(await readFile(path.join(root, "session.json"), "utf8"))).toEqual({
        chats: [
          {
            telegramChatId: 123,
            codexSessionId: "thread-old",
            status: "idle",
            updatedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a write-permission error with recovery guidance", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("write access denied")),
    };
    const normalized = {
      chatId: 123,
      userId: 456,
      chatType: "private" as const,
      text: "hello",
      replyContext: undefined,
      attachments: [],
    };

    await expect(
      handleNormalizedTelegramMessage(normalized, {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      }),
    ).rejects.toThrow();

    expect(api.editMessage).toHaveBeenLastCalledWith(
      123,
      11,
      "Error: File creation is blocked by the current write policy. Retry in a writable mode.",
    );
  });

  it("edits the placeholder to an error message when the bridge throws", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(
      handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir: path.join(os.tmpdir(), "ignored"),
        },
      ),
    ).rejects.toThrow("boom");

    expect(api.editMessage).toHaveBeenCalledWith(
      123,
      11,
      "Error: An unexpected failure occurred. Reset the chat or retry the request.",
    );
  });

  it("records categorized failures in audit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockRejectedValue(new Error("Not logged in · Please run /login")),
    };
    const normalized = {
      chatId: 123,
      userId: 456,
      chatType: "private" as const,
      text: "hello",
      replyContext: undefined,
      attachments: [],
    };

    try {
      await expect(
        handleNormalizedTelegramMessage(normalized, {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        }),
      ).rejects.toThrow();

      const audit = await readFile(path.join(root, "audit.log.jsonl"), "utf8");
      expect(audit).toContain('"failureCategory":"auth"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("chunks long responses by editing the placeholder with the first chunk and sending the rest", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "a".repeat(4500) }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
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

  it("sends a separate error message when a follow-up chunk fails after the placeholder was edited", async () => {
    const api = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 11 })
        .mockRejectedValueOnce(new Error("send failed"))
        .mockResolvedValueOnce({ message_id: 12 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "a".repeat(4500) }),
    };

    await expect(
      handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "hello",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir: path.join(os.tmpdir(), "ignored"),
        },
      ),
    ).rejects.toThrow("send failed");

    expect(api.editMessage).toHaveBeenCalledTimes(3);
    expect(api.editMessage).toHaveBeenNthCalledWith(1, 123, 11, "Checking access policy...");
    expect(api.editMessage).toHaveBeenNthCalledWith(2, 123, 11, "Working on your request...");
    expect(api.editMessage).toHaveBeenNthCalledWith(3, 123, 11, "a".repeat(4000));
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(500));
    expect(api.sendMessage).toHaveBeenNthCalledWith(
      3,
      123,
      "Error: An unexpected failure occurred. Reset the chat or retry the request.",
    );
  });

  it("passes quoted reply context to the bridge", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "reply",
        replyContext: {
          messageId: 77,
          text: "quoted text",
        },
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 123,
      userId: 456,
      chatType: "private",
      text: "reply",
      replyContext: {
        messageId: 77,
        text: "quoted text",
      },
      files: [],
    }));
  });

  it("sends a document when the model returns a file block", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi
        .fn()
        .mockResolvedValue({ text: "```file:report.txt\nhello world\n```" }),
    };

    await handleNormalizedTelegramMessage(
      {
        chatId: 123,
        userId: 456,
        chatType: "private",
        text: "send file",
        replyContext: undefined,
        attachments: [],
      },
      {
        api: api as never,
        bridge: bridge as never,
        inboxDir: path.join(os.tmpdir(), "ignored"),
      },
    );

    expect(api.editMessage).toHaveBeenNthCalledWith(3, 123, 11, "Sending file: report.txt");
    expect(api.sendDocument).toHaveBeenCalledWith(123, "report.txt", "hello world\n");
  });

  it("sends files generated into codex telegram-out directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }: { requestOutputDir?: string }) => {
        if (!requestOutputDir) {
          throw new Error("missing request output dir");
        }

        await writeFile(path.join(requestOutputDir, "hello.txt"), "hello from codex", "utf8");
        return { text: "done" };
      }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "请生成一个文件并传给我",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestOutputDir: expect.stringContaining(path.join("workspace", ".telegram-out")),
        }),
      );
      expect(api.sendDocument).toHaveBeenCalledWith(
        123,
        "hello.txt",
        expect.any(Uint8Array),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create codex telegram-out directories for ordinary messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const inboxDir = path.join(root, "inbox");
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex" }) + "\n", "utf8");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
      getFile: vi.fn(),
      downloadFile: vi.fn(),
    };
    const bridge = {
      checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
      handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    try {
      await handleNormalizedTelegramMessage(
        {
          chatId: 123,
          userId: 456,
          chatType: "private",
          text: "你好",
          replyContext: undefined,
          attachments: [],
        },
        {
          api: api as never,
          bridge: bridge as never,
          inboxDir,
        },
      );

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestOutputDir: undefined,
        }),
      );
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
