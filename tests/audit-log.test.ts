import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appendAuditEvent, resolveAuditLogPath } from "../src/state/audit-log.js";

describe("audit log", () => {
  it("appends jsonl events to the instance audit log", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      await appendAuditEvent(tempDir, {
        type: "access.allow",
        instanceName: "default",
        chatId: 123,
        outcome: "success",
      });
      await appendAuditEvent(tempDir, {
        type: "update.handle",
        instanceName: "default",
        updateId: 45,
        outcome: "error",
        detail: "boom",
      });

      const raw = await readFile(resolveAuditLogPath(tempDir), "utf8");
      const lines = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        type: "access.allow",
        instanceName: "default",
        chatId: 123,
        outcome: "success",
      });
      expect(lines[1]).toMatchObject({
        type: "update.handle",
        instanceName: "default",
        updateId: 45,
        outcome: "error",
        detail: "boom",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
