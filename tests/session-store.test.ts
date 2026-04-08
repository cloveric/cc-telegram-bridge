import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";

import { JsonStore } from "../src/state/json-store.js";
import type { SessionState } from "../src/types.js";

describe("JsonStore", () => {
  it("writes and reads SessionState atomically from a temp directory", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const filePath = path.join(tempDir, "session.json");
    const store = new JsonStore<SessionState>(filePath);
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
      await store.write(value);

      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).toBe(JSON.stringify(value, null, 2));
      await expect(stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });

      const readBack = await store.read({ chats: [] });
      expect(readBack).toEqual(value);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
