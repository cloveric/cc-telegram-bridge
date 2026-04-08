export class TelegramApi {
  constructor(private readonly botToken: string) {}

  private buildUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private async postJson(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(this.buildUrl(method), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegram API request failed for ${method}: ${response.status} ${response.statusText}`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error(`Telegram API response was not valid JSON for ${method}`);
    }
  }

  async sendMessage(chatId: number, text: string): Promise<unknown> {
    return this.postJson("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<unknown> {
    return this.postJson("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }
}
