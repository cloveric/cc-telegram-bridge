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
    ? "Session state was unreadable. An operator needs to repair the instance session state before this chat can be reset."
    : "Session reset for this chat.";
}

export function renderSessionStateErrorMessage(repairable: boolean): string {
  return repairable
    ? "Error: Session state is unreadable right now. The operator needs to repair session state and retry."
    : "Error: Session state is unavailable right now. The operator needs to restore read access and retry.";
}

export function renderTelegramHelpMessage(): string {
  return [
    "Telegram commands:",
    "/status - show engine, session, and file task state",
    "Send files directly to analyze them in chat.",
    "Archives pause after summary; reply \"继续分析\" or press Continue Analysis to continue this archive. Bare /continue resumes the latest waiting archive.",
    "/continue - resume the latest waiting archive",
    "/reset - clear the current chat session",
    "/help - show this help",
  ].join("\n");
}

export function renderTelegramStatusMessage(input: {
  engine: "codex" | "claude";
  sessionBound: boolean | null;
  blockingTasks: number | null;
  waitingTasks: number | null;
  sessionWarning?: string;
  taskStateWarning?: string;
}): string {
  const blockingTasksValue = input.blockingTasks ?? 0;
  const waitingTasksValue = input.waitingTasks ?? 0;
  const blockingTasks = Number.isFinite(blockingTasksValue) ? Math.max(0, Math.trunc(blockingTasksValue)) : 0;
  const waitingTasks = Number.isFinite(waitingTasksValue) ? Math.max(0, Math.trunc(waitingTasksValue)) : 0;

  return [
    `Engine: ${input.engine}`,
    input.sessionWarning
      ? `Session bound: unknown (${input.sessionWarning})`
      : `Session bound: ${input.sessionBound ? "yes" : "no"}`,
    input.taskStateWarning
      ? `Blocking file tasks: unknown (${input.taskStateWarning})`
      : `Blocking file tasks: ${blockingTasks}`,
    input.taskStateWarning
      ? `Waiting file tasks: unknown (${input.taskStateWarning})`
      : `Waiting file tasks: ${waitingTasks}`,
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
    return "Error: The engine runtime failed. Restart the instance and retry.";
  }

  if (category === "file-workflow") {
    return "Error: File handling failed while preparing your request. Retry with a smaller or different file.";
  }

  if (category === "workflow-state") {
    return "Error: Internal workflow state is unavailable right now. Retry the request later or ask the operator to inspect the service state.";
  }

  if (category === "session-state") {
    return "Error: Session state is unavailable right now. The operator needs to repair session state and retry.";
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
