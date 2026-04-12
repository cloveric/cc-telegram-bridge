# Codex Telegram-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Codex-backed Telegram bots return generated files through Telegram by writing them into a request-scoped `.telegram-out/<request-id>/` directory that the bridge scans and sends after the turn completes.

**Architecture:** Add a Codex-only request output directory contract at the bridge/adapter boundary, then let the Telegram delivery layer enumerate and send files from that directory after the turn. Keep Claude unchanged and preserve the existing fenced `file:` text-block path as a separate mechanism.

**Tech Stack:** TypeScript, Node.js fs/path APIs, existing Telegram `sendDocument` API, Vitest

---

## File Structure

**Create**
- `src/runtime/telegram-out.ts`
- `tests/telegram-out.test.ts`

**Modify**
- `src/codex/adapter.ts`
- `src/runtime/bridge.ts`
- `src/codex/process-adapter.ts`
- `src/codex/app-server-adapter.ts`
- `src/telegram/delivery.ts`
- `tests/bridge.test.ts`
- `tests/process-adapter.test.ts`
- `tests/app-server-adapter.test.ts`
- `tests/service.test.ts`

**Responsibilities**
- `src/runtime/telegram-out.ts`
  Creates request-scoped output dirs, lists produced files, applies count/size limits, and returns deterministic file lists.
- `src/codex/adapter.ts`
  Extends adapter input shape with Codex-only request output metadata.
- `src/runtime/bridge.ts`
  Adds the Codex-only output-dir contract without changing Claude behavior.
- `src/codex/process-adapter.ts`
  Merges `agent.md` with the per-request output-dir contract and passes it into `codex exec`.
- `src/codex/app-server-adapter.ts`
  Merges `agent.md` with the per-request output-dir contract and passes it into the app-server turn prompt.
- `src/telegram/delivery.ts`
  Creates request ids, collects Telegram-out files after successful Codex turns, and sends them using `sendDocument`.
- `tests/...`
  Pin behavior for empty dirs, single-file return, multi-file return, instruction merging, and Codex-only scoping.

---

### Task 1: Add Telegram-Out Runtime Helper

**Files:**
- Create: `src/runtime/telegram-out.ts`
- Test: `tests/telegram-out.test.ts`

- [ ] **Step 1: Write the failing test for request-scoped directory creation**

```typescript
it("creates a request-scoped telegram-out directory under workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));

  try {
    const result = await createTelegramOutDir(root, "req-123");

    expect(result.requestId).toBe("req-123");
    expect(result.dirPath).toBe(path.join(root, "workspace", ".telegram-out", "req-123"));
    await expect(stat(result.dirPath)).resolves.toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test -- tests/telegram-out.test.ts
```

Expected: fail with missing module / missing function.

- [ ] **Step 3: Implement the helper module**

```typescript
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface TelegramOutRequest {
  requestId: string;
  dirPath: string;
}

export async function createTelegramOutDir(stateDir: string, requestId: string): Promise<TelegramOutRequest> {
  const dirPath = path.join(stateDir, "workspace", ".telegram-out", requestId);
  await mkdir(dirPath, { recursive: true });
  return { requestId, dirPath };
}

export async function listTelegramOutFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}
```

- [ ] **Step 4: Add limit enforcement tests**

```typescript
it("filters out files beyond count and size limits", async () => {
  const files = [
    { path: "a.txt", size: 10 },
    { path: "b.txt", size: 10 },
    { path: "c.txt", size: 10 },
  ];

  const result = applyTelegramOutLimits(files, {
    maxFiles: 2,
    maxFileBytes: 100,
    maxTotalBytes: 30,
  });

  expect(result.accepted).toEqual(["a.txt", "b.txt"]);
});
```

- [ ] **Step 5: Implement limit enforcement**

```typescript
export interface TelegramOutLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export function applyTelegramOutLimits(
  files: Array<{ path: string; size: number }>,
  limits: TelegramOutLimits,
): { accepted: string[] } {
  const accepted: string[] = [];
  let total = 0;

  for (const file of files) {
    if (accepted.length >= limits.maxFiles) break;
    if (file.size > limits.maxFileBytes) continue;
    if (total + file.size > limits.maxTotalBytes) continue;
    accepted.push(file.path);
    total += file.size;
  }

  return { accepted };
}
```

- [ ] **Step 6: Run the focused test file and verify it passes**

Run:

```bash
npm test -- tests/telegram-out.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/runtime/telegram-out.ts tests/telegram-out.test.ts
git commit -m "feat: add request-scoped telegram-out runtime helper"
```

---

### Task 2: Add Codex-Only Adapter Input Plumbing

**Files:**
- Modify: `src/codex/adapter.ts`
- Modify: `src/runtime/bridge.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing bridge test for Codex-only output instructions**

```typescript
it("passes codex telegram-out instructions separately from user text", async () => {
  const adapter: CodexAdapter = {
    sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
    createSession: vi.fn(),
  };

  const bridge = new Bridge(accessStore, sessionManager, adapter);
  await bridge.handleAuthorizedMessage({
    chatId: 84,
    userId: 42,
    chatType: "private",
    text: "generate a file",
    files: [],
    requestOutputDir: "C:\\tmp\\workspace\\.telegram-out\\req-123",
  });

  expect(adapter.sendUserMessage).toHaveBeenCalledWith(
    "telegram-84",
    expect.objectContaining({
      text: "generate a file",
      instructions: expect.stringContaining("Files written to this directory will be returned"),
    }),
  );
});
```

- [ ] **Step 2: Run the bridge test to verify it fails**

Run:

```bash
npm test -- tests/bridge.test.ts
```

Expected: fail because the new field does not exist yet.

- [ ] **Step 3: Extend adapter input shape**

```typescript
export interface CodexUserMessageInput {
  text: string;
  files: string[];
  instructions?: string;
  onProgress?: (partialText: string) => void;
  requestOutputDir?: string;
}
```

- [ ] **Step 4: Add a bridge helper that renders Codex-only telegram-out instructions**

```typescript
function renderCodexTelegramOutInstructions(requestOutputDir: string): string {
  return [
    "[Codex Telegram-Out Contract]",
    `If you need to return a file to the user, write the final file into: ${requestOutputDir}`,
    "Only place files intended for Telegram delivery in that directory.",
    "Do not place scratch or temporary files there.",
    "Files written there will be returned to the user after the task completes.",
  ].join("\\n");
}
```

- [ ] **Step 5: Wire bridge to pass the output-dir instructions only when requestOutputDir exists**

```typescript
const response = await this.adapter.sendUserMessage(session.sessionId, {
  text,
  files: input.files,
  instructions: input.requestOutputDir
    ? renderCodexTelegramOutInstructions(input.requestOutputDir)
    : undefined,
  onProgress: input.onProgress,
  requestOutputDir: input.requestOutputDir,
});
```

- [ ] **Step 6: Re-run the bridge test and verify it passes**

Run:

```bash
npm test -- tests/bridge.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/codex/adapter.ts src/runtime/bridge.ts tests/bridge.test.ts
git commit -m "feat: add codex telegram-out request metadata"
```

---

### Task 3: Merge Telegram-Out Instructions Into Codex Adapters

**Files:**
- Modify: `src/codex/process-adapter.ts`
- Modify: `src/codex/app-server-adapter.ts`
- Test: `tests/process-adapter.test.ts`
- Test: `tests/app-server-adapter.test.ts`

- [ ] **Step 1: Write a failing process-adapter merge test**

```typescript
it("merges telegram-out instructions with agent.md for codex exec", async () => {
  const adapter = new ProcessCodexAdapter("codex", undefined, spawnCodex, instructionsPath);

  await adapter.sendUserMessage("telegram-12345", {
    text: "Hello",
    files: [],
    instructions: "[Codex Telegram-Out Contract]\\nwrite output here",
  });

  expect(calls[0]?.args[3]).toContain("You are bot alpha.");
  expect(calls[0]?.args[3]).toContain("[Codex Telegram-Out Contract]");
});
```

- [ ] **Step 2: Write the equivalent app-server merge test**

```typescript
it("merges telegram-out instructions with agent.md for app-server", async () => {
  const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, instructionsPath);

  const promise = adapter.sendUserMessage("telegram-12345", {
    text: "Hello",
    files: [],
    instructions: "[Codex Telegram-Out Contract]\\nwrite output here",
  });

  // initialize + thread/start omitted for brevity
  expect(turnStart.params.input[0].text).toContain("You are isolated.");
  expect(turnStart.params.input[0].text).toContain("[Codex Telegram-Out Contract]");
});
```

- [ ] **Step 3: Run both test files and verify they fail if merge logic is wrong**

Run:

```bash
npm test -- tests/process-adapter.test.ts tests/app-server-adapter.test.ts
```

Expected: fail when instructions overwrite each other or are absent.

- [ ] **Step 4: Reuse a shared combine strategy in both Codex adapters**

```typescript
function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\\n\\n") : null;
}
```

- [ ] **Step 5: Apply the combined instructions in both adapters**

```typescript
const instructions = combineInstructions(
  this.instructionsPath ? await this.loadInstructions() : null,
  input.instructions ?? null,
);
```

- [ ] **Step 6: Re-run both test files and verify they pass**

Run:

```bash
npm test -- tests/process-adapter.test.ts tests/app-server-adapter.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/codex/process-adapter.ts src/codex/app-server-adapter.ts tests/process-adapter.test.ts tests/app-server-adapter.test.ts
git commit -m "fix: merge telegram-out instructions into codex adapters"
```

---

### Task 4: Deliver Telegram-Out Files After Codex Turns

**Files:**
- Modify: `src/telegram/delivery.ts`
- Modify: `tests/service.test.ts`
- Create: `src/runtime/telegram-out.ts`
- Test: `tests/telegram-out.test.ts`

- [ ] **Step 1: Write the failing service test for one returned file**

```typescript
it("sends a generated codex file from the request output directory", async () => {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    editMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 12 }),
    getFile: vi.fn(),
    downloadFile: vi.fn(),
  };

  const bridge = {
    checkAccess: vi.fn().mockResolvedValue({ kind: "allow" }),
    handleAuthorizedMessage: vi.fn().mockImplementation(async ({ requestOutputDir }) => {
      await writeFile(path.join(requestOutputDir, "hello.txt"), "hello world", "utf8");
      return { text: "done" };
    }),
  };

  await handleNormalizedTelegramMessage(message, { api, bridge, inboxDir });

  expect(api.sendDocument).toHaveBeenCalledWith(123, "hello.txt", expect.any(Uint8Array));
});
```

- [ ] **Step 2: Write a failing service test for empty output**

```typescript
it("does not send a document when the request output directory is empty", async () => {
  // same setup but no file written
  expect(api.sendDocument).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the service and telegram-out tests to verify failure**

Run:

```bash
npm test -- tests/service.test.ts tests/telegram-out.test.ts
```

Expected: fail because no request output dir is created or scanned.

- [ ] **Step 4: Add request output dir creation in delivery for Codex-backed requests**

```typescript
const requestId = randomUUID();
const telegramOut = await createTelegramOutDir(stateDir, requestId);
```

- [ ] **Step 5: Pass the request output dir through bridge only for Codex runtime**

```typescript
const result = await context.bridge.handleAuthorizedMessage({
  chatId: normalized.chatId,
  userId: normalized.userId,
  chatType: normalized.chatType,
  text: normalized.text,
  replyContext: normalized.replyContext,
  files,
  onProgress,
  requestOutputDir: isCodexInstance ? telegramOut.dirPath : undefined,
});
```

- [ ] **Step 6: Enumerate and send produced files after a successful result**

```typescript
const producedFiles = await listTelegramOutFiles(telegramOut.dirPath);
for (const producedFile of producedFiles) {
  const contents = await readFile(producedFile);
  await context.api.sendDocument(normalized.chatId, path.basename(producedFile), contents);
}
```

- [ ] **Step 7: Apply count/size limits before sending**

```typescript
const candidates = await describeTelegramOutFiles(telegramOut.dirPath);
const limited = applyTelegramOutLimits(candidates, {
  maxFiles: 5,
  maxFileBytes: 512_000,
  maxTotalBytes: 1_500_000,
});
```

- [ ] **Step 8: Re-run service and telegram-out tests**

Run:

```bash
npm test -- tests/service.test.ts tests/telegram-out.test.ts
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/runtime/telegram-out.ts src/telegram/delivery.ts tests/service.test.ts tests/telegram-out.test.ts
git commit -m "feat: send codex telegram-out files after successful turns"
```

---

### Task 5: Final Verification

**Files:**
- Modify: none unless verification reveals issues
- Test: full suite

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run the production build**

Run:

```bash
npm run build
```

Expected: TypeScript build succeeds with no errors.

- [ ] **Step 3: Restart the Codex-backed service instance for manual verification**

Run:

```bash
node dist/src/index.js service restart --instance default
node dist/src/index.js service status --instance default
```

Expected: service reports `Running: yes` and a fresh PID.

- [ ] **Step 4: Manual smoke check**

Trigger in Telegram:

```text
你能传输我个文件吗，随便什么都行，你自己生成，然后传过来
```

Expected:
- Codex writes a file into `.telegram-out/<request-id>/`
- Telegram receives `sendDocument`
- Final text reply still appears

- [ ] **Step 5: Commit any verification-driven fixes**

```bash
git add .
git commit -m "test: verify codex telegram-out delivery end-to-end"
```
