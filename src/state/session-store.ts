import { JsonStore } from "./json-store.js";
import type { SessionRecord, SessionState } from "../types.js";

export const DEFAULT_SESSION_STATE: SessionState = { chats: [] };

export class SessionStore {
  private readonly store: JsonStore<SessionState>;

  constructor(filePath: string) {
    this.store = new JsonStore<SessionState>(filePath);
  }

  async load(): Promise<SessionState> {
    return this.store.read(DEFAULT_SESSION_STATE);
  }

  async upsert(record: SessionRecord): Promise<void> {
    const state = await this.load();
    const index = state.chats.findIndex((entry) => entry.telegramChatId === record.telegramChatId);

    if (index === -1) {
      state.chats.push(record);
    } else {
      state.chats[index] = record;
    }

    await this.store.write(state);
  }

  async findByChatId(telegramChatId: number): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => record.telegramChatId === telegramChatId) ?? null;
  }
}
