export type FailureCategory =
  | "auth"
  | "write-permission"
  | "telegram-conflict"
  | "telegram-delivery"
  | "engine-cli"
  | "file-workflow"
  | "session-state"
  | "unknown";

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join("\n");
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export function classifyFailure(error: unknown): FailureCategory {
  const text = normalizeErrorText(error).toLowerCase();

  if (
    text.includes("not logged in") ||
    text.includes("unauthorized") ||
    text.includes("unauthorised") ||
    text.includes("missing bearer") ||
    text.includes("please run /login") ||
    text.includes("login required")
  ) {
    return "auth";
  }

  if (
    text.includes("read-only") ||
    text.includes("write access denied") ||
    text.includes("permission denied") ||
    text.includes("write permission") ||
    text.includes("read only")
  ) {
    return "write-permission";
  }

  if (text.includes("409 conflict") || text.includes("telegram conflict") || text.includes("another process is polling")) {
    return "telegram-conflict";
  }

  if (
    text.includes("senddocument") ||
    text.includes("sendmessage") ||
    text.includes("editmessage") ||
    text.includes("telegram api") ||
    text.includes("telegram delivery") ||
    text.includes("message to edit not found") ||
    text.includes("bad request: chat not found")
  ) {
    return "telegram-delivery";
  }

  if (
    text.includes("archive") ||
    text.includes("attachment") ||
    text.includes("extract") ||
    text.includes("extraction") ||
    text.includes("pdf text") ||
    text.includes("zip") ||
    text.includes("file workflow")
  ) {
    return "file-workflow";
  }

  if (text.includes("session state") || text.includes("session-state") || text.includes("session binding") || text.includes("session")) {
    return "session-state";
  }

  if (
    text.includes("codex") ||
    text.includes("claude") ||
    text.includes("app-server") ||
    text.includes("turn.failed") ||
    text.includes("engine cli")
  ) {
    return "engine-cli";
  }

  return "unknown";
}
