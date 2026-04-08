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

export interface BridgeAccessInput {
  chatId: number;
  userId: number;
  chatType: string;
}

export interface BridgeAccessDecision {
  kind: "allow" | "reply" | "deny";
  text?: string;
}

export class Bridge {
  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
  ) {}

  async checkAccess(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    const accessState = await this.accessStore.load();

    if (input.chatType !== "private") {
      return {
        kind: "reply",
        text: "Only private chats are supported.",
      };
    }

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.chatId)) {
      return {
        kind: "deny",
        text: "This chat is not authorized.",
      };
    }

    if (
      accessState.policy === "pairing" &&
      !accessState.pairedUsers.some(
        (user) => user.telegramChatId === input.chatId && input.userId === input.chatId,
      )
    ) {
      const pendingPair = await this.accessStore.issuePairingCode({
        telegramUserId: input.userId,
        telegramChatId: input.chatId,
        now: new Date(),
      });

      return {
        kind: "reply",
        text: `Pair this chat with code ${pendingPair.code}`,
      };
    }

    return { kind: "allow" };
  }

  async handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    text: string;
    files: string[];
  }) {
    const decision = await this.checkAccess(input);
    if (decision.kind === "deny") {
      throw new Error(decision.text ?? "This chat is not authorized.");
    }
    if (decision.kind === "reply") {
      return {
        text: decision.text ?? "This chat is not authorized.",
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
