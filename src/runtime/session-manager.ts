import { SessionStore } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly adapter: CodexAdapter,
  ) {}

  async getOrCreateSession(chatId: number): Promise<{ sessionId: string }> {
    const existing = await this.sessionStore.findByChatId(chatId);

    if (existing) {
      return { sessionId: existing.codexSessionId };
    }

    return { sessionId: `telegram-${chatId}` };
  }

  async bindSession(chatId: number, sessionId: string): Promise<void> {
    await this.sessionStore.upsert({
      telegramChatId: chatId,
      codexSessionId: sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
  }
}
