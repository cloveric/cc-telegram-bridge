type TelegramOkResponse<T> = {
  ok: true;
  result: T;
};

type TelegramErrorResponse = {
  ok: false;
  description?: string;
};

type TelegramApiResponse<T> = TelegramOkResponse<T> | TelegramErrorResponse;

function isTelegramApiResponse<T>(value: unknown): value is TelegramApiResponse<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("ok" in value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    return "result" in value;
  }

  if ("description" in value && typeof value.description !== "string") {
    return false;
  }

  return true;
}

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

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error(`Telegram API response was not valid JSON for ${method}`);
    }

    if (!isTelegramApiResponse<T>(json)) {
      throw new Error(`Telegram API response had an unexpected shape for ${method}`);
    }

    const payload = json;

    if (!payload.ok) {
      throw new Error(`Telegram API request failed for ${method}: ${payload.description ?? "unknown error"}`);
    }

    return payload.result;
  }

  private async requestTelegramResponse<T>(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse<T>> {
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

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error(`Telegram API response was not valid JSON for ${method}`);
    }

    if (!isTelegramApiResponse<T>(json)) {
      throw new Error(`Telegram API response had an unexpected shape for ${method}`);
    }

    return json;
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

  async getUpdates(offset?: number): Promise<unknown[]> {
    const body: Record<string, unknown> = {};
    if (offset !== undefined) {
      body.offset = offset;
    }

    const json = await this.requestTelegramResponse<unknown[]>("getUpdates", body);

    if (!json.ok) {
      throw new Error(`Telegram API request failed for getUpdates: ${json.description ?? "unknown error"}`);
    }

    return json.result ?? [];
  }
}
