import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";

import { JsonStore } from "../src/state/json-store.js";
import { SESSION_STATE_UNREADABLE_WARNING, SessionStore } from "../src/state/session-store.js";
import type { SessionRecord, SessionState } from "../src/types.js";

describe("JsonStore", () => {
  it("writes and reads SessionState atomically from a temp directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new JsonStore<SessionState>(filePath, (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "chats" in value &&
        Array.isArray((value as SessionState).chats)
      ) {
        return value as SessionState;
      }

      throw new Error("invalid session state");
    });
    const value: SessionState = {
      chats: [
        {
          telegramChatId: 123,
          codexSessionId: "session-1",
          status: "running",
          updatedAt: "2026-04-08T03:00:00.000Z",
        },
      ],
    };

    try {
      await writeFile(`${filePath}.tmp`, "stale-temp-file", "utf8");
      await store.write(value);

      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).toBe(JSON.stringify(value, null, 2));
      expect(await readFile(`${filePath}.tmp`, "utf8")).toBe("stale-temp-file");

      const readBack = await store.read({ chats: [] });
      expect(readBack).toEqual(value);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore", () => {
  function createRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      telegramChatId: 123,
      codexSessionId: "session-1",
      status: "running",
      updatedAt: "2026-04-08T03:00:00.000Z",
      ...overrides,
    };
  }

  it("upsert then findByChatId", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      const record = createRecord();
      await store.upsert(record);

      await expect(store.findByChatId(123)).resolves.toEqual(record);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("upsert replaces existing record for the same chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await store.upsert(createRecord({ codexSessionId: "session-1", status: "running" }));
      await store.upsert(createRecord({ codexSessionId: "session-2", status: "queued" }));

      await expect(store.findByChatId(123)).resolves.toEqual(createRecord({ codexSessionId: "session-2", status: "queued" }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("upsert keeps concurrent writes from losing records", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      const writes = [
        store.upsert(createRecord({ telegramChatId: 101, codexSessionId: "session-101" })),
        store.upsert(createRecord({ telegramChatId: 102, codexSessionId: "session-102" })),
        store.upsert(createRecord({ telegramChatId: 103, codexSessionId: "session-103" })),
      ];

      await Promise.all(writes);

      await expect(store.findByChatId(101)).resolves.toEqual(
        createRecord({ telegramChatId: 101, codexSessionId: "session-101" }),
      );
      await expect(store.findByChatId(102)).resolves.toEqual(
        createRecord({ telegramChatId: 102, codexSessionId: "session-102" }),
      );
      await expect(store.findByChatId(103)).resolves.toEqual(
        createRecord({ telegramChatId: 103, codexSessionId: "session-103" }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes a single chat session without touching other bindings", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await store.upsert({
        telegramChatId: 100,
        codexSessionId: "thread-a",
        status: "idle",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      await store.upsert({
        telegramChatId: 200,
        codexSessionId: "thread-b",
        status: "idle",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });

      await store.removeByChatId(100);
      const state = await store.load();

      expect(state.chats).toEqual([
        expect.objectContaining({ telegramChatId: 200, codexSessionId: "thread-b" }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removeByChatId returns true for an existing chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await store.upsert(createRecord({ telegramChatId: 100 }));

      await expect(store.removeByChatId(100)).resolves.toBe(true);
      await expect(store.findByChatId(100)).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removeByChatId returns false for a missing chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await expect(store.removeByChatId(999)).resolves.toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns fresh default state when the file is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      const first = await store.load();
      first.chats.push(createRecord());

      const second = await store.load();
      expect(second).toEqual({ chats: [] });
      expect(second).not.toBe(first);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt persisted state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          chats: [
            {
              telegramChatId: 123,
              codexSessionId: "session-1",
              status: "not-a-real-status",
              updatedAt: "2026-04-08T03:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(store.load()).rejects.toThrow("invalid session state");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats permission-denied reads as unreadable session state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new SessionStore(filePath);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn((store as unknown as { store: JsonStore<SessionState> }).store, "read");

    readSpy.mockRejectedValue(permissionError);

    try {
      await expect(store.inspect()).resolves.toEqual({
        state: { chats: [] },
        warning: SESSION_STATE_UNREADABLE_WARNING,
      });
    } finally {
      readSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
