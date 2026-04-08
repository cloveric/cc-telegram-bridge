import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { AccessStore } from "../src/state/access-store.js";

describe("Bridge", () => {
  it("routes an authorized message through the current session", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(accessStore.load).toHaveBeenCalledTimes(1);
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(84);
    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", {
      text: "hello",
      files: [],
    });
    expect(result.text).toBe("done");
    expect(sessionManager.bindSession).not.toHaveBeenCalled();
  });

  it("rejects a message when the chat is not on the allowlist", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [99],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 42,
        chatType: "private",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).rejects.toThrow("This chat is not authorized for this instance.");
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });

  it("blocks an unknown chat in pairing mode and returns a pairing code", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [],
        allowlist: [99],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn().mockResolvedValue({
        code: "ABC123",
      }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(result).toEqual({
      text: "Pair this private chat with code ABC123",
    });
    expect(accessStore.issuePairingCode).toHaveBeenCalledWith({
      telegramUserId: 42,
      telegramChatId: 84,
      now: expect.any(Date),
    });
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });

  it("allows a paired chat in pairing mode", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [
          {
            telegramUserId: 42,
            telegramChatId: 84,
            pairedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(result).toEqual({ text: "done" });
    expect(accessStore.issuePairingCode).not.toHaveBeenCalled();
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(84);
    expect(adapter.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("requires a revoked chat to pair again under pairing policy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const accessStore = new AccessStore(path.join(dir, "access.json"));
      const issued = await accessStore.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });
      await accessStore.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"));
      await accessStore.revokeChat(84);

      const sessionManager: SessionManagerLike = {
        getOrCreateSession: vi.fn(),
        bindSession: vi.fn(),
      };
      const adapter: CodexAdapter = {
        sendUserMessage: vi.fn(),
        createSession: vi.fn(),
      };

      const bridge = new Bridge(accessStore, sessionManager, adapter);
      const result = await bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 42,
        chatType: "private",
        text: "hello again",
        replyContext: undefined,
        files: [],
      });

      expect(result.text).toMatch(/^Pair this private chat with code [A-Z2-9]{6}$/);
      expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
      expect(adapter.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists a newly established codex thread id after the first message", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "pairing",
        pairedUsers: [{ telegramChatId: 84, telegramUserId: 84 }],
        allowlist: [],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn().mockResolvedValue(undefined),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done", sessionId: "thread-123" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 84,
      chatType: "private",
      text: "hello",
      replyContext: undefined,
      files: [],
    });

    expect(result).toEqual({ text: "done", sessionId: "thread-123" });
    expect(sessionManager.bindSession).toHaveBeenCalledWith(84, "thread-123");
  });

  it("rejects non-private chats with a product-facing message", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 84,
        chatType: "group",
        text: "hello",
        replyContext: undefined,
        files: [],
      }),
    ).resolves.toEqual({ text: "This bot only accepts private chats." });
  });

  it("includes quoted reply context in the prompt", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
      issuePairingCode: vi.fn(),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
      bindSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      chatType: "private",
      text: "answer this",
      replyContext: {
        messageId: 99,
        text: "quoted text",
      },
      files: [],
    });

    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", {
      text: "answer this\n\n[Quoted message #99]\nquoted text",
      files: [],
    });
  });
});
