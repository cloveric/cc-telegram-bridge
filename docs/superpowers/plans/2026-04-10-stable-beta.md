# Stable Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Telegram bridge into a stable beta by hardening reliability, adding operator tooling, and polishing the Telegram user flow without introducing a new platform layer.

**Architecture:** Keep the current `adapter -> bridge -> delivery -> state` runtime core intact. Add a small failure-classification layer, richer file-backed store helpers, new CLI commands for sessions and tasks, and a narrow Telegram command surface. Use TDD for each change and keep commits small by phase.

**Tech Stack:** TypeScript, Node.js, Vitest, file-backed JSON state, Telegram Bot API

---

## File Structure

### Create

- `src/runtime/error-classification.ts`
- `src/commands/task.ts`
- `tests/file-workflow-store.test.ts`

### Modify

- `src/state/session-store.ts`
- `src/state/file-workflow-store.ts`
- `src/state/audit-log.ts`
- `src/runtime/bridge.ts`
- `src/telegram/delivery.ts`
- `src/telegram/message-renderer.ts`
- `src/telegram/api.ts`
- `src/telegram/update-normalizer.ts`
- `src/commands/session.ts`
- `src/commands/service.ts`
- `src/commands/cli.ts`
- `README.md`

### Existing Tests To Extend

- `tests/session-store.test.ts`
- `tests/audit-log.test.ts`
- `tests/bridge.test.ts`
- `tests/service-command.test.ts`
- `tests/cli.test.ts`
- `tests/message-renderer.test.ts`
- `tests/service.test.ts`

### Responsibility Map

- `src/runtime/error-classification.ts`: Convert raw runtime and Telegram failures into stable product-facing categories.
- `src/state/session-store.ts`: Add mutable session lifecycle helpers used by CLI and Telegram reset flows.
- `src/state/file-workflow-store.ts`: Add listing, lookup, and clearing helpers for operator tooling.
- `src/state/audit-log.ts`: Support categorized error summaries and latest-failure lookup.
- `src/commands/task.ts`: Task inspection and cleanup commands over `file-workflow.json`.
- `src/commands/session.ts`: Session inspection and reset commands over `session.json`.
- `src/commands/service.ts`: Enrich doctor output with categorized failures, unresolved task counts, and recovery hints.
- `src/commands/cli.ts`: Wire new `session`, `task`, and enhanced service commands into the top-level CLI.
- `src/telegram/delivery.ts`: Route slash commands, classify failures, and expose operator-friendly Telegram replies.
- `src/telegram/message-renderer.ts`: Centralize new user-facing strings for status, reset, tasks, and help.
- `src/telegram/api.ts`: Add minimal optional inline keyboard and callback acknowledgment support.
- `src/telegram/update-normalizer.ts`: Parse callback queries into a normalized command shape.

---

### Task 1: Extend File-Backed Stores For Session and Task Recovery

**Files:**
- Modify: `src/state/session-store.ts`
- Modify: `src/state/file-workflow-store.ts`
- Test: `tests/session-store.test.ts`
- Test: `tests/file-workflow-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/session-store.test.ts
it("removes a single chat session without touching other bindings", async () => {
  const store = new SessionStore(filePath);
  await store.upsert({
    telegramChatId: 100,
    codexSessionId: "thread-a",
    status: "idle",
    updatedAt: "2026-04-10T00:00:00.000Z",
  });
  await store.upsert({
    telegramChatId: 200,
    codexSessionId: "thread-b",
    status: "idle",
    updatedAt: "2026-04-10T00:00:00.000Z",
  });

  await store.removeByChatId(100);
  const state = await store.load();

  expect(state.chats).toEqual([
    expect.objectContaining({ telegramChatId: 200, codexSessionId: "thread-b" }),
  ]);
});

// tests/file-workflow-store.test.ts
it("lists records newest-first and clears a single upload", async () => {
  const store = new FileWorkflowStore(stateDir);
  await store.append({
    uploadId: "one",
    chatId: 100,
    userId: 100,
    kind: "archive",
    status: "awaiting_continue",
    sourceFiles: ["a.zip"],
    derivedFiles: [],
    summary: "first",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
  });
  await store.append({
    uploadId: "two",
    chatId: 100,
    userId: 100,
    kind: "document",
    status: "failed",
    sourceFiles: ["b.pdf"],
    derivedFiles: [],
    summary: "second",
    createdAt: "2026-04-10T00:01:00.000Z",
    updatedAt: "2026-04-10T00:01:00.000Z",
  });

  expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["two", "one"]);
  await store.remove("one");
  expect((await store.list({ chatId: 100 })).map((record) => record.uploadId)).toEqual(["two"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/session-store.test.ts tests/file-workflow-store.test.ts`

Expected: FAIL with missing `removeByChatId`, missing `list`, or missing `remove`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/state/session-store.ts
async removeByChatId(telegramChatId: number): Promise<boolean> {
  let removed = false;
  await this.enqueueWrite(async () => {
    const state = await this.load();
    const nextChats = state.chats.filter((record) => record.telegramChatId !== telegramChatId);
    removed = nextChats.length !== state.chats.length;
    if (!removed) {
      return;
    }
    state.chats = nextChats;
    await this.store.write(state);
  });
  return removed;
}

// src/state/file-workflow-store.ts
async list(filter: { chatId?: number; status?: FileWorkflowStatus } = {}): Promise<FileWorkflowRecord[]> {
  const state = await this.load();
  return state.records
    .filter((record) => filter.chatId === undefined || record.chatId === filter.chatId)
    .filter((record) => filter.status === undefined || record.status === filter.status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async find(uploadId: string): Promise<FileWorkflowRecord | null> {
  return (await this.load()).records.find((record) => record.uploadId === uploadId) ?? null;
}

async remove(uploadId: string): Promise<boolean> {
  const state = await this.load();
  const nextRecords = state.records.filter((record) => record.uploadId !== uploadId);
  if (nextRecords.length === state.records.length) {
    return false;
  }
  state.records = nextRecords;
  await this.store.write(state);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/session-store.test.ts tests/file-workflow-store.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/session-store.test.ts tests/file-workflow-store.test.ts src/state/session-store.ts src/state/file-workflow-store.ts
git commit -m "feat: add session and task recovery store helpers"
```

---

### Task 2: Add Failure Classification and Audit Summaries

**Files:**
- Create: `src/runtime/error-classification.ts`
- Modify: `src/state/audit-log.ts`
- Test: `tests/audit-log.test.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/audit-log.test.ts
it("returns the latest categorized failure from audit history", () => {
  const events = parseAuditEvents([
    JSON.stringify({
      timestamp: "2026-04-10T00:00:00.000Z",
      type: "update.handle",
      outcome: "error",
      detail: "Error: Not logged in",
      metadata: { failureCategory: "auth" },
    }),
    JSON.stringify({
      timestamp: "2026-04-10T00:01:00.000Z",
      type: "update.handle",
      outcome: "error",
      detail: "Error: write access denied",
      metadata: { failureCategory: "write-permission" },
    }),
  ].join("\n"));

  expect(getLatestFailure(events)).toEqual({
    timestamp: "2026-04-10T00:01:00.000Z",
    category: "write-permission",
    detail: "Error: write access denied",
  });
});

// tests/service.test.ts
it("records categorized failures in audit metadata", async () => {
  bridge.handleAuthorizedMessage = vi.fn().mockRejectedValue(new Error("Not logged in · Please run /login"));

  await expect(handleNormalizedTelegramMessage(normalized, context)).rejects.toThrow();

  const audit = await readFile(path.join(root, "audit.log.jsonl"), "utf8");
  expect(audit).toContain('"failureCategory":"auth"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/audit-log.test.ts tests/service.test.ts`

Expected: FAIL with missing `getLatestFailure` or missing `failureCategory`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/error-classification.ts
export type FailureCategory =
  | "auth"
  | "write-permission"
  | "telegram-conflict"
  | "telegram-delivery"
  | "engine-cli"
  | "file-workflow"
  | "session-state"
  | "unknown";

export function classifyFailure(error: unknown): FailureCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/not logged in|unauthorized|missing bearer/i.test(message)) return "auth";
  if (/read-only|write access denied|permission denied/i.test(message)) return "write-permission";
  if (/409\\s*conflict/i.test(message)) return "telegram-conflict";
  if (/senddocument|telegram api request failed/i.test(message)) return "telegram-delivery";
  if (/archive|pdf text extraction|attachment/i.test(message)) return "file-workflow";
  if (/session/i.test(message)) return "session-state";
  if (/codex|claude|app-server|turn\\.failed/i.test(message)) return "engine-cli";
  return "unknown";
}

// src/state/audit-log.ts
export interface LatestFailureSummary {
  timestamp: string;
  category: string;
  detail?: string;
}

export function getLatestFailure(events: AuditEvent[]): LatestFailureSummary | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.outcome !== "error" || !event.timestamp) {
      continue;
    }
    return {
      timestamp: event.timestamp,
      category: typeof event.metadata?.failureCategory === "string" ? event.metadata.failureCategory : "unknown",
      detail: event.detail,
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/audit-log.test.ts tests/service.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/audit-log.test.ts tests/service.test.ts src/runtime/error-classification.ts src/state/audit-log.ts
git commit -m "feat: classify runtime failures for operator diagnostics"
```

---

### Task 3: Apply Failure Categories and Session Reset Flow In Delivery

**Files:**
- Modify: `src/telegram/delivery.ts`
- Modify: `src/telegram/message-renderer.ts`
- Modify: `src/runtime/bridge.ts`
- Test: `tests/service.test.ts`
- Test: `tests/message-renderer.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/service.test.ts
it("resets the current chat session when /reset is sent", async () => {
  await writeFile(path.join(root, "session.json"), JSON.stringify({
    chats: [{
      telegramChatId: 123,
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-04-10T00:00:00.000Z",
    }],
  }));

  await handleNormalizedTelegramMessage({
    chatId: 123,
    userId: 456,
    chatType: "private",
    text: "/reset",
    replyContext: undefined,
    attachments: [],
  }, context);

  expect(api.editMessage).toHaveBeenLastCalledWith(123, 11, "Session reset for this chat.");
  expect(await readFile(path.join(root, "session.json"), "utf8")).toContain('"chats":[]');
});

it("renders a write-permission error with recovery guidance", async () => {
  bridge.handleAuthorizedMessage = vi.fn().mockRejectedValue(new Error("write access denied"));
  await expect(handleNormalizedTelegramMessage(normalized, context)).rejects.toThrow();
  expect(api.editMessage).toHaveBeenLastCalledWith(
    123,
    11,
    "Error: File creation is blocked by the current write policy. Reset the chat or retry in a writable mode.",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/service.test.ts tests/message-renderer.test.ts`

Expected: FAIL with missing `/reset` handling or missing categorized error copy.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/telegram/message-renderer.ts
export function renderSessionResetMessage(): string {
  return "Session reset for this chat.";
}

export function renderCategorizedErrorMessage(category: FailureCategory, detail: string): string {
  switch (category) {
    case "write-permission":
      return "Error: File creation is blocked by the current write policy. Reset the chat or retry in a writable mode.";
    case "auth":
      return "Error: Engine authentication is missing or expired. Re-login for this instance and retry.";
    case "telegram-conflict":
      return "Error: Another Telegram poller is using this bot token. Stop the duplicate service and retry.";
    default:
      return `Error: ${detail}`;
  }
}

// src/telegram/delivery.ts
if (normalized.text.trim() === "/reset") {
  const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
  await sessionStore.removeByChatId(normalized.chatId);
  await context.api.editMessage(normalized.chatId, placeholderMessageId, renderSessionResetMessage());
  return;
}

// in catch block
const failureCategory = classifyFailure(error);
await appendAuditEvent(path.dirname(context.inboxDir), {
  type: "update.handle",
  outcome: "error",
  detail: message,
  metadata: {
    durationMs: Date.now() - startedAt,
    attachments: normalized.attachments.length,
    failureCategory,
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/service.test.ts tests/message-renderer.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/service.test.ts tests/message-renderer.test.ts src/telegram/delivery.ts src/telegram/message-renderer.ts src/runtime/bridge.ts
git commit -m "feat: add categorized delivery errors and session reset flow"
```

---

### Task 4: Add Session and Task Operator Commands

**Files:**
- Create: `src/commands/task.ts`
- Modify: `src/commands/session.ts`
- Modify: `src/commands/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cli.test.ts
it("shows the current chat session for a single chat", async () => {
  const handled = await runCli(["telegram", "session", "inspect", "--instance", "alpha", "84"], {
    env: { USERPROFILE: tempDir },
    logger: { log: (message) => messages.push(message) },
  });

  expect(handled).toBe(true);
  expect(messages[0]).toContain("Chat: 84");
  expect(messages[0]).toContain("Thread: thread-123");
});

it("clears a file workflow upload by id", async () => {
  const handled = await runCli(["telegram", "task", "clear", "--instance", "alpha", "upload-123"], {
    env: { USERPROFILE: tempDir },
    logger: { log: (message) => messages.push(message) },
  });

  expect(handled).toBe(true);
  expect(messages[0]).toContain('Cleared task "upload-123"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli.test.ts`

Expected: FAIL with unsupported `session inspect`, `session reset`, or `task` command.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/commands/session.ts
export async function resetSessionForChat(
  env: SessionCommandEnv,
  instanceName: string,
  chatId: number,
): Promise<boolean> {
  const store = new SessionStore(resolveSessionStatePath(env, instanceName));
  return store.removeByChatId(chatId);
}

// src/commands/task.ts
export async function listTasks(env: TaskCommandEnv, instanceName: string): Promise<FileWorkflowRecord[]> {
  const store = new FileWorkflowStore(resolveInstanceStateDir({ ...env, CODEX_TELEGRAM_INSTANCE: instanceName }));
  return store.list();
}

export async function clearTask(env: TaskCommandEnv, instanceName: string, uploadId: string): Promise<boolean> {
  const store = new FileWorkflowStore(resolveInstanceStateDir({ ...env, CODEX_TELEGRAM_INSTANCE: instanceName }));
  return store.remove(uploadId);
}

// src/commands/cli.ts
if (argv[0] === "session" && argv[1] === "inspect") { /* parse chat id and print inspect result */ }
if (argv[0] === "session" && argv[1] === "reset") { /* parse chat id and print reset result */ }
if (argv[0] === "task" && argv[1] === "list") { /* print task rows */ }
if (argv[0] === "task" && argv[1] === "clear") { /* clear upload and print result */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/cli.test.ts src/commands/task.ts src/commands/session.ts src/commands/cli.ts
git commit -m "feat: add session and task operator commands"
```

---

### Task 5: Enrich Service Doctor Output

**Files:**
- Modify: `src/commands/service.ts`
- Modify: `src/commands/cli.ts`
- Test: `tests/service-command.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/service-command.test.ts
it("reports latest failure category and unresolved tasks in doctor output", async () => {
  const handled = await runCli(["telegram", "service", "doctor", "--instance", "alpha"], {
    env: { USERPROFILE: tempDir },
    logger: { log: (message) => messages.push(message) },
    serviceDeps: {
      cwd: tempDir,
      isProcessAlive: () => true,
      isExpectedServiceProcess: () => true,
    },
  });

  expect(handled).toBe(true);
  expect(messages[0]).toContain("latest failure category: write-permission");
  expect(messages[0]).toContain("unresolved tasks: 2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/service-command.test.ts`

Expected: FAIL because doctor output does not include categorized failure or unresolved task count.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/commands/service.ts
const auditEvents = parseAuditEvents(await readAuditLog(paths.stateDir));
const latestFailure = getLatestFailure(auditEvents);
const taskStore = new FileWorkflowStore(paths.stateDir);
const unresolvedTasks = (await taskStore.list()).filter((record) => record.status !== "completed").length;

checks.push({
  name: "recent failures",
  ok: !latestFailure,
  detail: latestFailure
    ? `latest failure category: ${latestFailure.category} (${latestFailure.detail ?? "no detail"})`
    : "no recent categorized failures",
});
checks.push({
  name: "workflow tasks",
  ok: unresolvedTasks === 0,
  detail: `unresolved tasks: ${unresolvedTasks}`,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/service-command.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/service-command.test.ts src/commands/service.ts src/commands/cli.ts
git commit -m "feat: enrich doctor output with task and failure summaries"
```

---

### Task 6: Add Telegram Slash Commands and Help Copy

**Files:**
- Modify: `src/telegram/delivery.ts`
- Modify: `src/telegram/message-renderer.ts`
- Test: `tests/service.test.ts`
- Test: `tests/message-renderer.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/service.test.ts
it("returns a concise status message for /status", async () => {
  await handleNormalizedTelegramMessage({
    chatId: 123,
    userId: 456,
    chatType: "private",
    text: "/status",
    replyContext: undefined,
    attachments: [],
  }, context);

  expect(api.editMessage).toHaveBeenLastCalledWith(
    123,
    11,
    expect.stringContaining("Engine: codex"),
  );
  expect(api.editMessage).toHaveBeenLastCalledWith(
    123,
    11,
    expect.stringContaining("Pending file tasks:"),
  );
});

it("returns help text for /help", async () => {
  await handleNormalizedTelegramMessage({
    chatId: 123,
    userId: 456,
    chatType: "private",
    text: "/help",
    replyContext: undefined,
    attachments: [],
  }, context);

  expect(api.editMessage).toHaveBeenLastCalledWith(
    123,
    11,
    expect.stringContaining("/help"),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/service.test.ts tests/message-renderer.test.ts`

Expected: FAIL because `/status` and `/help` are not handled.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/telegram/message-renderer.ts
export function renderTelegramHelpMessage(): string {
  return [
    "Commands:",
    "/status - show engine and task state",
    "/reset - clear this chat session",
    "/help - show this message",
  ].join("\n");
}

export function renderTelegramStatusMessage(input: {
  engine: "codex" | "claude";
  sessionBound: boolean;
  pendingTasks: number;
}): string {
  return [
    `Engine: ${input.engine}`,
    `Session bound: ${input.sessionBound ? "yes" : "no"}`,
    `Pending file tasks: ${input.pendingTasks}`,
  ].join("\n");
}

// src/telegram/delivery.ts
if (normalized.text.trim() === "/help") {
  await context.api.editMessage(normalized.chatId, placeholderMessageId, renderTelegramHelpMessage());
  return;
}

if (normalized.text.trim() === "/status") {
  const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
  const taskStore = new FileWorkflowStore(stateDir);
  const engine = await loadEngine(stateDir);
  const sessionBound = Boolean(await sessionStore.findByChatId(normalized.chatId));
  const pendingTasks = (await taskStore.list({ chatId: normalized.chatId }))
    .filter((record) => record.status !== "completed").length;

  await context.api.editMessage(
    normalized.chatId,
    placeholderMessageId,
    renderTelegramStatusMessage({ engine, sessionBound, pendingTasks }),
  );
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/service.test.ts tests/message-renderer.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/service.test.ts tests/message-renderer.test.ts src/telegram/delivery.ts src/telegram/message-renderer.ts
git commit -m "feat: add stable beta telegram status and help commands"
```

---

### Task 7: Add Minimal Shortcut Buttons

**Files:**
- Modify: `src/telegram/api.ts`
- Modify: `src/telegram/update-normalizer.ts`
- Modify: `src/telegram/delivery.ts`
- Test: `tests/service.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/service.test.ts
it("shows a continue-analysis shortcut button after archive summary", async () => {
  await handleNormalizedTelegramMessage(archiveUploadUpdate, context);

  expect(api.editMessage).toHaveBeenCalledWith(
    123,
    11,
    expect.stringContaining("Continue Analysis"),
    expect.objectContaining({
      inlineKeyboard: [[{ text: "Continue Analysis", callbackData: "continue-latest-archive" }]],
    }),
  );
});

it("maps continue-latest-archive callback queries to the /continue flow", async () => {
  const normalized = normalizeUpdate({
    update_id: 99,
    callback_query: {
      id: "cb-1",
      from: { id: 456 },
      message: { message_id: 11, chat: { id: 123, type: "private" }, text: "Archive summary" },
      data: "continue-latest-archive",
    },
  });

  expect(normalized).toEqual(expect.objectContaining({ text: "/continue" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/service.test.ts`

Expected: FAIL because `editMessage` cannot send markup and callback queries are ignored.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/telegram/api.ts
export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

type MessageOptions = {
  inlineKeyboard?: InlineKeyboardButton[][];
};

async sendMessage(chatId: number, text: string, options: MessageOptions = {}): Promise<TelegramMessage> {
  return this.postJson("sendMessage", {
    chat_id: chatId,
    text,
    ...(options.inlineKeyboard
      ? { reply_markup: { inline_keyboard: options.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } }
      : {}),
  }, isTelegramMessage);
}

async editMessage(chatId: number, messageId: number, text: string, options: MessageOptions = {}): Promise<TelegramMessage> {
  return this.postJson("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(options.inlineKeyboard
      ? { reply_markup: { inline_keyboard: options.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } }
      : {}),
  }, isTelegramMessage);
}

async answerCallbackQuery(callbackQueryId: string): Promise<void> {
  await this.postJson("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
  });
}

// src/telegram/update-normalizer.ts
if (update?.callback_query?.data === "continue-latest-archive") {
  return {
    chatId: update.callback_query.message.chat.id,
    userId: update.callback_query.from.id,
    chatType: update.callback_query.message.chat.type,
    text: "/continue",
    callbackQueryId: update.callback_query.id,
    replyContext: undefined,
    attachments: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/service.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/service.test.ts src/telegram/api.ts src/telegram/update-normalizer.ts src/telegram/delivery.ts
git commit -m "feat: add minimal telegram shortcut buttons"
```

---

### Task 8: Update Help and Operator Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-10-stable-beta-design.md`
- Test: none

- [ ] **Step 1: Write the documentation changes**

```md
## Stable Beta Commands

- `telegram service doctor --instance <name>`
- `telegram session inspect --instance <name> <chat-id>`
- `telegram session reset --instance <name> <chat-id>`
- `telegram task list --instance <name>`
- `telegram task clear --instance <name> <upload-id>`

Telegram users can also use:

- `/status`
- `/reset`
- `/help`
```

- [ ] **Step 2: Run a focused sanity check**

Run: `npm test -- tests/cli.test.ts tests/service-command.test.ts tests/service.test.ts`

Expected: PASS

- [ ] **Step 3: Run the full verification suite**

Run: `npm test`
Expected: all tests pass

Run: `npm run build`
Expected: TypeScript build succeeds

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-04-10-stable-beta-design.md
git commit -m "docs: document stable beta operations and telegram commands"
```

- [ ] **Step 5: Push and smoke test**

Run: `git push origin main`
Expected: push succeeds

Run: `node dist/src/index.js service stop --instance default`
Expected: service stops cleanly

Run: `node dist/src/index.js service start --instance default`
Expected: service starts cleanly with a fresh pid

Run manual smoke tests in Telegram:
- send `/status`
- send `/help`
- upload a zip and hit `Continue Analysis`
- force a write-denied file request and verify categorized error copy

Expected: all stable beta flows behave as documented
