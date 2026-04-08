export interface CodexSessionHandle {
  sessionId: string;
}

export interface CodexAdapterResponse {
  text: string;
}

export interface CodexAdapter {
  createSession(chatId: number): Promise<CodexSessionHandle>;
  sendUserMessage(
    sessionId: string,
    input: { text: string; files: string[] },
  ): Promise<CodexAdapterResponse>;
}
