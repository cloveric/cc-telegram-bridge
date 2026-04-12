export interface NormalizedTelegramAttachment {
  fileId: string;
  fileName?: string;
  kind: "document" | "photo" | "voice";
}

export interface NormalizedTelegramMessage {
  chatId: number;
  userId: number;
  chatType: string;
  text: string;
  callbackQueryId?: string;
  replyContext?: {
    messageId: number;
    text: string;
    photoFileId?: string;
    documentFileId?: string;
    documentFileName?: string;
  };
  attachments: NormalizedTelegramAttachment[];
}

function normalizeReplyContext(message: any): NormalizedTelegramMessage["replyContext"] {
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

  let photoFileId: string | undefined;
  if (Array.isArray(reply?.photo) && reply.photo.length > 0) {
    const largest = reply.photo[reply.photo.length - 1];
    if (typeof largest?.file_id === "string") {
      photoFileId = largest.file_id;
    }
  }

  let documentFileId: string | undefined;
  let documentFileName: string | undefined;
  if (typeof reply?.document?.file_id === "string") {
    documentFileId = reply.document.file_id;
    documentFileName = typeof reply.document.file_name === "string" ? reply.document.file_name : undefined;
  }

  return {
    messageId,
    text: replyText,
    photoFileId,
    documentFileId,
    documentFileName,
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

function normalizeVoiceAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.voice?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }

  return [
    {
      fileId,
      kind: "voice",
    },
  ];
}

export function normalizeUpdate(update: any): NormalizedTelegramMessage | null {
  const callbackQuery = update?.callback_query;
  const rawCallbackData =
    typeof callbackQuery?.data === "string" && callbackQuery.data.startsWith("continue-archive:")
      ? callbackQuery.data.slice("continue-archive:".length).trim()
      : null;
  const callbackData =
    rawCallbackData && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCallbackData)
      ? rawCallbackData
      : null;
  if (callbackData) {
    const message = callbackQuery.message;
    const chatId = message?.chat?.id;
    const userId = callbackQuery?.from?.id;
    const chatType = message?.chat?.type;

    if (typeof chatId !== "number" || typeof userId !== "number" || typeof chatType !== "string") {
      return null;
    }

    return {
      chatId,
      userId,
      chatType,
      text: `/continue --upload ${callbackData}`,
      callbackQueryId: typeof callbackQuery.id === "string" ? callbackQuery.id : undefined,
      attachments: [],
    };
  }

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
    attachments: [...normalizeDocumentAttachment(message), ...normalizePhotoAttachment(message), ...normalizeVoiceAttachment(message)],
  };
}
