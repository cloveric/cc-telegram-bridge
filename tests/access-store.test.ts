import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomInt: vi.fn(),
  };
});

import { AccessStore } from "../src/state/access-store.js";

const mockRandomInt = randomInt as unknown as {
  mockImplementation: (implementation: (...args: unknown[]) => number) => void;
  mockReturnValue: (value: number) => void;
  mockReset: () => void;
};

afterEach(() => {
  mockRandomInt.mockReset();
});

function setRandomIntSequence(sequence: number[]): void {
  let index = 0;
  mockRandomInt.mockImplementation(() => {
    const value = sequence[index++];
    if (value === undefined) {
      throw new Error("randomInt sequence exhausted");
    }

    return value;
  });
}

describe("AccessStore", () => {
  it("returns isolated default state objects for different stores", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const storeA = new AccessStore(path.join(dir, "access-a.json"));
      const storeB = new AccessStore(path.join(dir, "access-b.json"));

      const stateA = await storeA.load();
      stateA.allowlist.push(123);

      const stateB = await storeB.load();

      expect(stateB).toEqual({
        policy: "pairing",
        pairedUsers: [],
        allowlist: [],
        pendingPairs: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists pairing codes and paired users", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      expect(issued.code).toHaveLength(6);

      const pairedUser = await store.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"));

      expect(pairedUser?.telegramUserId).toBe(42);

      const state = await store.load();
      expect(state.pairedUsers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes expired pairing codes when redeeming them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      const pairedUser = await store.redeemPairingCode(issued.code, new Date("2026-04-08T00:06:00Z"));

      expect(pairedUser).toBeNull();
      expect((await store.load()).pendingPairs).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces the pending pairing code for the same user", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      setRandomIntSequence([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
      const store = new AccessStore(path.join(dir, "access.json"));

      const firstIssued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });
      const secondIssued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:01:00Z"),
      });

      const state = await store.load();

      expect(firstIssued.code).toBe("AAAAAA");
      expect(secondIssued.code).toBe("BBBBBB");
      expect(state.pendingPairs).toHaveLength(1);
      expect(state.pendingPairs[0]?.code).toBe("BBBBBB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an invalid pairing code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      mockRandomInt.mockReturnValue(0);
      const store = new AccessStore(path.join(dir, "access.json"));
      await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      await expect(store.redeemPairingCode("ZZZZZZ", new Date("2026-04-08T00:01:00Z"))).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify(
          {
            policy: "pairing",
            pairedUsers: [{}],
            allowlist: [],
            pendingPairs: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const store = new AccessStore(filePath);
      await expect(store.load()).rejects.toThrow("invalid access state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt timestamp strings in persisted access state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const filePath = path.join(dir, "access.json");
      await writeFile(
        filePath,
        JSON.stringify(
          {
            policy: "pairing",
            pairedUsers: [
              {
                telegramUserId: 42,
                telegramChatId: 84,
                pairedAt: "not-a-timestamp",
              },
            ],
            allowlist: [],
            pendingPairs: [
              {
                code: "ABC123",
                telegramUserId: 42,
                telegramChatId: 84,
                expiresAt: "also-not-a-timestamp",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const store = new AccessStore(filePath);
      await expect(store.load()).rejects.toThrow("invalid access state");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
