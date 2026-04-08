import type { CodexAdapter } from "../codex/adapter.js";

export interface AccessStoreLike {
  load(): Promise<{
    policy: "pairing" | "allowlist";
    allowlist: number[];
    pendingPairs: unknown[];
    pairedUsers: Array<{
      telegramChatId: number;
    }>;
  }>;
  issuePairingCode(input: {
    telegramUserId: number;
    telegramChatId: number;
    now: Date;
  }): Promise<{
    code: string;
  }>;
}

export interface SessionManagerLike {
  getOrCreateSession(chatId: number): Promise<{ sessionId: string }>;
  bindSession(chatId: number, sessionId: string): Promise<void>;
}

export class Bridge {
  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
  ) {}

  async handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    text: string;
    files: string[];
  }) {
    const accessState = await this.accessStore.load();

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.chatId)) {
      throw new Error("User is not in the allowlist");
    }

    if (
      accessState.policy === "pairing" &&
      !accessState.pairedUsers.some((user) => user.telegramChatId === input.chatId)
    ) {
      const pendingPair = await this.accessStore.issuePairingCode({
        telegramUserId: input.userId,
        telegramChatId: input.chatId,
        now: new Date(),
      });

      return {
        text: `Pair this chat with code ${pendingPair.code}`,
      };
    }

    const session = await this.sessionManager.getOrCreateSession(input.chatId);
    const response = await this.adapter.sendUserMessage(session.sessionId, {
      text: input.text,
      files: input.files,
    });

    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(input.chatId, response.sessionId);
    }

    return response;
  }
}
