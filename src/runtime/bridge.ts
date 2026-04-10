import type { CodexAdapter } from "../codex/adapter.js";
import {
  renderPairingMessage,
  renderPrivateChatRequiredMessage,
  renderUnauthorizedMessage,
} from "../telegram/message-renderer.js";

export interface AccessStoreLike {
  load(): Promise<{
    policy: "pairing" | "allowlist";
    allowlist: number[];
    pendingPairs: unknown[];
    pairedUsers: Array<{
      telegramUserId: number;
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

function renderTelegramBridgeCapabilities(): string {
  return [
    "You are running inside a Telegram chat bridge. The bridge supports delivering files to the user.",
    "When the user asks you to generate, create, or send a file, include exactly one fenced code block in your reply using this format:",
    "",
    "```file:example.py",
    "print('hello')",
    "```",
    "",
    "The bridge will automatically extract the block and deliver it as a Telegram document attachment.",
    "Use this for small text or code files. For large files, save them to the workspace instead.",
  ].join("\n");
}

function renderCodexTelegramOutInstructions(requestOutputDir: string): string {
  return [
    "[Codex Telegram-Out Contract]",
    "For small text or code files, prefer returning exactly one fenced block in this format:",
    "",
    "```file:example.txt",
    "hello",
    "```",
    "",
    "The bridge will extract that block and deliver it as a Telegram attachment.",
    "Use the output directory below only when the file must exist on disk, is large, or is not suitable for an inline file block.",
    `If you need to return a file to the user, write the final file into: ${requestOutputDir}`,
    "Only place files intended for Telegram delivery in that directory.",
    "Do not place scratch or temporary files there.",
    "Files written there will be returned to the user after the task completes.",
  ].join("\n");
}

function combineInstructions(...values: Array<string | undefined>): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export class Bridge {
  private readonly bridgeInstructionMode: "generic-file-blocks" | "telegram-out-only";

  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
  ) {
    this.bridgeInstructionMode = adapter.bridgeInstructionMode ?? "generic-file-blocks";
  }

  async checkAccess(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    const accessState = await this.accessStore.load();

    if (input.chatType !== "private") {
      return {
        kind: "reply",
        text: renderPrivateChatRequiredMessage(),
      };
    }

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.chatId)) {
      return {
        kind: "deny",
        text: renderUnauthorizedMessage(),
      };
    }

    if (
      accessState.policy === "pairing" &&
      !accessState.pairedUsers.some(
        (user) => user.telegramChatId === input.chatId && user.telegramUserId === input.userId,
      )
    ) {
      const pendingPair = await this.accessStore.issuePairingCode({
        telegramUserId: input.userId,
        telegramChatId: input.chatId,
        now: new Date(),
      });

      return {
        kind: "reply",
        text: renderPairingMessage(pendingPair.code),
      };
    }

    return { kind: "allow" };
  }

  async handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    text: string;
    replyContext?: {
      messageId: number;
      text: string;
    };
    files: string[];
    onProgress?: (partialText: string) => void;
    requestOutputDir?: string;
  }) {
    const decision = await this.checkAccess(input);
    if (decision.kind === "deny") {
      throw new Error(decision.text ?? renderUnauthorizedMessage());
    }
    if (decision.kind === "reply") {
      return {
        text: decision.text ?? renderUnauthorizedMessage(),
      };
    }

    const session = await this.sessionManager.getOrCreateSession(input.chatId);
    const baseText = input.replyContext
      ? `${input.text}\n\n[Quoted message #${input.replyContext.messageId}]\n${input.replyContext.text || "(no text content)"}`
      : input.text;
    const text = baseText;
    const instructions =
      this.bridgeInstructionMode === "telegram-out-only"
        ? combineInstructions(
            input.requestOutputDir ? renderCodexTelegramOutInstructions(input.requestOutputDir) : undefined,
          )
        : combineInstructions(
            renderTelegramBridgeCapabilities(),
            input.requestOutputDir ? renderCodexTelegramOutInstructions(input.requestOutputDir) : undefined,
          );
    const response = await this.adapter.sendUserMessage(session.sessionId, {
      text,
      files: input.files,
      instructions,
      onProgress: input.onProgress,
      requestOutputDir: input.requestOutputDir,
    });

    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(input.chatId, response.sessionId);
    }

    return response;
  }
}
