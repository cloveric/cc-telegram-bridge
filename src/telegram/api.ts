type TelegramOkResponse<T> = {
  ok: true;
  result: T;
};

type TelegramErrorResponse = {
  ok: false;
  description?: string;
};

type TelegramApiResponse<T> = TelegramOkResponse<T> | TelegramErrorResponse;

export class TelegramApi {
  constructor(private readonly botToken: string) {}

  private buildUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private async postJson<T>(method: string, body: Record<string, unknown>): Promise<T> {
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

    let payload: TelegramApiResponse<T>;

    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new Error(`Telegram API response was not valid JSON for ${method}`);
    }

    if (!payload.ok) {
      throw new Error(`Telegram API request failed for ${method}: ${payload.description ?? "unknown error"}`);
    }

    return payload.result;
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
