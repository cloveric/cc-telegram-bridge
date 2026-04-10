export interface CodexSessionHandle {
  sessionId: string;
}

export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
}

export interface CodexAdapterResponse {
  text: string;
  sessionId?: string;
  usage?: AdapterUsage;
}

export interface CodexUserMessageInput {
  text: string;
  files: string[];
  instructions?: string;
  onProgress?: (partialText: string) => void;
  requestOutputDir?: string;
}

export interface CodexAdapter {
  bridgeInstructionMode?: "generic-file-blocks" | "telegram-out-only";
  /**
   * Creates a logical session binding for a Telegram chat.
   * Implementations may be stateless at first and should not imply
   * persisted Codex conversation continuity unless they actually provide it.
   */
  createSession(chatId: number): Promise<CodexSessionHandle>;
  sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse>;
}
