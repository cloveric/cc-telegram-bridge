export interface CodexSessionHandle {
  sessionId: string;
}

export interface CodexAdapterResponse {
  text: string;
  sessionId?: string;
}

export interface CodexUserMessageInput {
  text: string;
  files: string[];
}

export interface CodexAdapter {
  /**
   * Creates a logical session binding for a Telegram chat.
   * Implementations may be stateless at first and should not imply
   * persisted Codex conversation continuity unless they actually provide it.
   */
  createSession(chatId: number): Promise<CodexSessionHandle>;
  sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse>;
}
