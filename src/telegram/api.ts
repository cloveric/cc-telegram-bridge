export class TelegramApi {
  constructor(private readonly botToken: string) {}

  private buildUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  async sendMessage(chatId: number, text: string): Promise<unknown> {
    const response = await fetch(this.buildUrl("sendMessage"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    return response.json();
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<unknown> {
    const response = await fetch(this.buildUrl("editMessageText"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
      }),
    });

    return response.json();
  }
}
