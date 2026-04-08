import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CodexAdapter } from "../src/codex/adapter.js";

describe("SessionManager", () => {
  it("returns a logical placeholder before a real thread is bound", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);

    try {
      await expect(manager.getOrCreateSession(84)).resolves.toEqual({
        sessionId: "telegram-84",
      });
      expect(adapter.createSession).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a bound thread id after the chat is persisted", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);

    try {
      await manager.bindSession(84, "thread-123");

      await expect(manager.getOrCreateSession(84)).resolves.toEqual({
        sessionId: "thread-123",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
