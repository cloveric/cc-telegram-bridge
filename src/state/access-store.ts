import { randomInt } from "node:crypto";

import { JsonStore } from "./json-store.js";
import type { AccessState, PairedUser, PendingPair } from "../types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const PAIRING_TTL_MS = 5 * 60 * 1000;

function createDefaultAccessState(): AccessState {
  return {
    policy: "pairing",
    pairedUsers: [],
    allowlist: [],
    pendingPairs: [],
  };
}

function generateCode(): string {
  let code = "";

  for (let index = 0; index < CODE_LENGTH; index++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }

  return code;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPairedUser(value: unknown): value is PairedUser {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PairedUser>;
  return (
    typeof candidate.telegramUserId === "number" &&
    typeof candidate.telegramChatId === "number" &&
    isIsoTimestamp(candidate.pairedAt)
  );
}

function isPendingPair(value: unknown): value is PendingPair {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PendingPair>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.telegramUserId === "number" &&
    typeof candidate.telegramChatId === "number" &&
    isIsoTimestamp(candidate.expiresAt)
  );
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isAccessState(value: unknown): value is AccessState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AccessState>;
  return (
    (candidate.policy === "pairing" || candidate.policy === "allowlist") &&
    Array.isArray(candidate.pairedUsers) &&
    candidate.pairedUsers.every(isPairedUser) &&
    isNumberArray(candidate.allowlist) &&
    Array.isArray(candidate.pendingPairs) &&
    candidate.pendingPairs.every(isPendingPair)
  );
}

export class AccessStore {
  private readonly store: JsonStore<AccessState>;

  constructor(filePath: string) {
    this.store = new JsonStore<AccessState>(filePath, (value) => {
      if (isAccessState(value)) {
        return value;
      }

      throw new Error("invalid access state");
    });
  }

  async load(): Promise<AccessState> {
    return this.store.read(createDefaultAccessState());
  }

  async issuePairingCode({
    telegramUserId,
    telegramChatId,
    now,
  }: {
    telegramUserId: number;
    telegramChatId: number;
    now: Date;
  }): Promise<PendingPair> {
    const state = await this.load();

    state.pendingPairs = state.pendingPairs.filter((pair) => pair.telegramUserId !== telegramUserId);
    const pendingCodes = new Set(state.pendingPairs.map((pair) => pair.code));

    let code = generateCode();
    while (pendingCodes.has(code)) {
      code = generateCode();
    }

    const pendingPair: PendingPair = {
      code,
      telegramUserId,
      telegramChatId,
      expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    };

    state.pendingPairs.push(pendingPair);

    await this.store.write(state);
    return pendingPair;
  }

  async redeemPairingCode(code: string, now: Date): Promise<PairedUser | null> {
    const state = await this.load();
    const pendingPair = state.pendingPairs.find((pair) => pair.code === code);

    if (!pendingPair) {
      return null;
    }

    state.pendingPairs = state.pendingPairs.filter((pair) => pair.code !== code);

    if (new Date(pendingPair.expiresAt).getTime() <= now.getTime()) {
      await this.store.write(state);
      return null;
    }

    const pairedUser: PairedUser = {
      telegramUserId: pendingPair.telegramUserId,
      telegramChatId: pendingPair.telegramChatId,
      pairedAt: now.toISOString(),
    };

    state.pairedUsers = state.pairedUsers.filter(
      (user) =>
        user.telegramUserId !== pairedUser.telegramUserId || user.telegramChatId !== pairedUser.telegramChatId,
    );
    state.pairedUsers.push(pairedUser);
    state.allowlist = [...new Set([...state.allowlist, pendingPair.telegramChatId])];

    await this.store.write(state);
    return pairedUser;
  }
}
