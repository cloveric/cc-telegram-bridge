export interface NormalizedTelegramAttachment {
  fileId: string;
  fileName?: string;
  kind: "document" | "photo";
}

export interface NormalizedTelegramMessage {
  chatId: number;
  userId: number;
  chatType: string;
  text: string;
  replyContext?: {
    messageId: number;
    text: string;
  };
  attachments: NormalizedTelegramAttachment[];
}

function normalizeReplyContext(message: any): { messageId: number; text: string } | undefined {
  const reply = message?.reply_to_message;
  const messageId = reply?.message_id;
  if (typeof messageId !== "number") {
    return undefined;
  }

  const replyText =
    typeof reply?.text === "string"
      ? reply.text
      : typeof reply?.caption === "string"
        ? reply.caption
        : "";

  if (!replyText) {
    return {
      messageId,
      text: "",
    };
  }

  return {
    messageId,
    text: replyText,
  };
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
  const chatType = message?.chat?.type;

  if (typeof chatId !== "number" || typeof userId !== "number" || typeof chatType !== "string") {
    return null;
  }

  return {
    chatId,
    userId,
    chatType,
    text:
      typeof message.text === "string"
        ? message.text
        : typeof message.caption === "string"
          ? message.caption
          : "",
    replyContext: normalizeReplyContext(message),
    attachments: [...normalizeDocumentAttachment(message), ...normalizePhotoAttachment(message)],
  };
}
