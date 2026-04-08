import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

export interface TelegramMessage {
  message_id: number;
  text?: string;
}

export interface TelegramFile {
  file_id?: string;
  file_path: string;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  return typeof value === "object" && value !== null && "message_id" in value && typeof value.message_id === "number";
}

function isTelegramFile(value: unknown): value is TelegramFile {
  return typeof value === "object" && value !== null && "file_path" in value && typeof value.file_path === "string";
}

function isTelegramUpdateArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export class TelegramApi {
  constructor(private readonly botToken: string) {}

  private buildUrl(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private buildFileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
  }

  private async postJson<T>(
    method: string,
    body: Record<string, unknown>,
    validateResult?: (value: unknown) => value is T,
  ): Promise<T> {
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

    if (validateResult && !validateResult(payload.result)) {
      throw new Error(`Telegram API response had an unexpected result shape for ${method}`);
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

  async sendMessage(chatId: number, text: string): Promise<TelegramMessage> {
    return this.postJson("sendMessage", {
      chat_id: chatId,
      text,
    }, isTelegramMessage);
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<TelegramMessage> {
    return this.postJson("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    }, isTelegramMessage);
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.postJson("getFile", {
      file_id: fileId,
    }, isTelegramFile);
  }

  async downloadFile(filePath: string, destinationPath: string): Promise<void> {
    const response = await fetch(this.buildFileUrl(filePath));

    if (!response.ok) {
      throw new Error(`Telegram API request failed for downloadFile: ${response.status} ${response.statusText}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, bytes);
  }

  async getUpdates(offset?: number): Promise<unknown[]> {
    const body: Record<string, unknown> = {};
    if (offset !== undefined) {
      body.offset = offset;
    }

    return this.postJson("getUpdates", body, isTelegramUpdateArray);
  }
}
