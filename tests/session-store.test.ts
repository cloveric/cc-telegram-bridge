import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";

import { JsonStore } from "../src/state/json-store.js";
import type { SessionState } from "../src/types.js";

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
