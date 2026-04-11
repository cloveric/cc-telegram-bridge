import type { FailureCategory } from "../runtime/error-classification.js";

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

export function renderSessionResetMessage(repaired = false): string {
  return repaired
    ? "Session reset. Previous session state was unreadable, so it was repaired."
    : "Session reset for this chat.";
}

export function renderTelegramHelpMessage(): string {
  return [
    "Telegram commands:",
    "/status - show engine, session, and file task state",
    "Send files directly to analyze them in chat.",
    "Archives pause after summary; reply \"继续分析\" or press Continue Analysis to keep going.",
    "/reset - clear the current chat session",
    "/help - show this help",
  ].join("\n");
}

export function renderTelegramStatusMessage(input: {
  engine: "codex" | "claude";
  sessionBound: boolean | null;
  pendingTasks: number | null;
  sessionWarning?: string;
  pendingTasksWarning?: string;
}): string {
  const pendingTasksValue = input.pendingTasks ?? 0;
  const pendingTasks = Number.isFinite(pendingTasksValue) ? Math.max(0, Math.trunc(pendingTasksValue)) : 0;

  return [
    `Engine: ${input.engine}`,
    input.sessionWarning
      ? `Session bound: unknown (${input.sessionWarning})`
      : `Session bound: ${input.sessionBound ? "yes" : "no"}`,
    input.pendingTasksWarning
      ? `Pending file tasks: unknown (${input.pendingTasksWarning})`
      : `Pending file tasks: ${pendingTasks}`,
  ].join("\n");
}

export function renderCategorizedErrorMessage(category: FailureCategory, detail: string): string {
  if (category === "write-permission") {
    return "Error: File creation is blocked by the current write policy. Retry in a writable mode.";
  }

  if (category === "auth") {
    return "Error: Engine authentication is missing or expired. Re-login for this instance and retry.";
  }

  if (category === "telegram-conflict") {
    return "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.";
  }

  if (category === "telegram-delivery") {
    return "Error: Telegram delivery is temporarily unavailable. Retry the request or try again later.";
  }

  if (category === "engine-cli") {
    return "Error: The engine process failed to start. Restart the instance and retry.";
  }

  if (category === "file-workflow") {
    return "Error: File handling failed while preparing your request. Retry with a smaller or different file.";
  }

  if (category === "session-state") {
    return "Error: Session state is unavailable right now. Reset the chat and try again.";
  }

  if (category === "unknown") {
    return "Error: An unexpected failure occurred. Reset the chat or retry the request.";
  }

  return renderErrorMessage(detail);
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
