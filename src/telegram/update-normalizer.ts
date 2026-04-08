export interface NormalizedTelegramMessage {
  chatId: number;
  userId: number;
  text: string;
}

export function normalizeUpdate(update: any): NormalizedTelegramMessage | null {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;

  if (typeof chatId !== "number" || typeof userId !== "number") {
    return null;
  }

  return {
    chatId,
    userId,
    text: typeof message.text === "string" ? message.text : "",
  };
}
