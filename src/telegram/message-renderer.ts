export function chunkTelegramMessage(text: string, limit = 4000): string[] {
  if (limit <= 0) {
    throw new RangeError("limit must be greater than 0");
  }

  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks;
}

export function renderWorkingMessage(): string {
  return "Working...";
}

export function renderErrorMessage(error: string): string {
  return `Error: ${error}`;
}
