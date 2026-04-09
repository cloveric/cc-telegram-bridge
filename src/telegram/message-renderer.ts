export function chunkTelegramMessage(text: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || !Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks;
}

export function renderWorkingMessage(): string {
  return "Received. Starting your session...";
}

export function renderErrorMessage(error: string): string {
  return `Error: ${error}`;
}

export function renderAccessCheckMessage(): string {
  return "Checking access policy...";
}

export function renderAttachmentDownloadMessage(count: number): string {
  return `Downloading ${count} attachment${count === 1 ? "" : "s"}...`;
}

export function renderExecutionMessage(): string {
  return "Working on your request...";
}

export function renderUnauthorizedMessage(): string {
  return "This chat is not authorized for this instance.";
}

export function renderPrivateChatRequiredMessage(): string {
  return "This bot only accepts private chats.";
}

export function renderPairingMessage(code: string): string {
  return `Pair this private chat with code ${code}`;
}
