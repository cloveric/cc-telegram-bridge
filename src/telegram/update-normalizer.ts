export interface NormalizedTelegramAttachment {
  fileId: string;
  fileName?: string;
  kind: "document" | "photo";
}

export interface NormalizedTelegramMessage {
  chatId: number;
  userId: number;
  text: string;
  attachments: NormalizedTelegramAttachment[];
}

function normalizeDocumentAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.document?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }

  return [
    {
      fileId,
      fileName: typeof message.document.file_name === "string" ? message.document.file_name : undefined,
      kind: "document",
    },
  ];
}

function normalizePhotoAttachment(message: any): NormalizedTelegramAttachment[] {
  if (!Array.isArray(message?.photo) || message.photo.length === 0) {
    return [];
  }

  const candidate = message.photo[message.photo.length - 1];
  if (typeof candidate?.file_id !== "string" || candidate.file_id.length === 0) {
    return [];
  }

  return [
    {
      fileId: candidate.file_id,
      kind: "photo",
    },
  ];
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
    attachments: [...normalizeDocumentAttachment(message), ...normalizePhotoAttachment(message)],
  };
}
