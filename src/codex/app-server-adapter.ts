import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: { toString(): string } | string) => void): void;
};

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end?(callback?: () => void): void;
};

type AppServerChildProcess = {
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: () => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => AppServerChildProcess;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
  method?: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PendingTurn = {
  chunks: string[];
  finalText?: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
};

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const normalizedCommand = normalizeExecutableCommand(command);

  if (/\.(cmd|bat)$/i.test(normalizedCommand)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, ...args],
    };
  }

  if (/\.ps1$/i.test(normalizedCommand)) {
    return {
      command: "pwsh",
      args: ["-NoProfile", "-File", normalizedCommand, ...args],
    };
  }

  return { command: normalizedCommand, args, shell: false };
}

export class CodexAppServerAdapter implements CodexAdapter {
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;
  private readonly instructionsPath: string | undefined;
  private child: AppServerChildProcess | null = null;
  private initializePromise: Promise<void> | null = null;
  private lineBuffer = "";
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly loadedThreads = new Set<string>();

  constructor(
    private readonly codexExecutable: string,
    private readonly cwd: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnCodex,
    spawnCodexArg?: SpawnCodex,
    instructionsPath?: string,
    engineHomePath?: string,
  ) {
    this.childEnv =
      typeof childEnvOrSpawn === "function"
        ? (() => {
            const env = { ...process.env };
            delete env.TELEGRAM_BOT_TOKEN;
            if (engineHomePath) {
              env.CODEX_HOME = engineHomePath;
            }
            return env;
          })()
        : childEnvOrSpawn ?? (() => {
            const env = { ...process.env };
            delete env.TELEGRAM_BOT_TOKEN;
            if (engineHomePath) {
              env.CODEX_HOME = engineHomePath;
            }
            return env;
          })();

    this.spawnCodex =
      typeof childEnvOrSpawn === "function"
        ? childEnvOrSpawn
        : spawnCodexArg ?? (spawn as unknown as SpawnCodex);
    this.instructionsPath = instructionsPath;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    await this.ensureInitialized();

    const instructions = input.instructions ?? (this.instructionsPath ? await this.loadInstructions() : null);
    const prompt = this.buildPrompt(input, instructions);
    const threadId = isLogicalTelegramSessionId(sessionId) ? await this.startThread() : await this.ensureThreadLoaded(sessionId);
    const text = await this.startTurn(threadId, prompt);

    return {
      text: text.trim() || `Session ${threadId} completed.`,
      sessionId: threadId !== sessionId ? threadId : undefined,
    };
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }

    try {
      const content = await readFile(this.instructionsPath, "utf8");
      const trimmed = content.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  private buildPrompt(input: CodexUserMessageInput, instructions: string | null): string {
    const parts: string[] = [];

    if (instructions) {
      parts.push(`[System Instructions]\n${instructions}\n[End Instructions]`);
    }

    parts.push(input.text);
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    return parts.join("\n");
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.startChildAndInitialize();
    }

    return this.initializePromise;
  }

  private async startChildAndInitialize(): Promise<void> {
    const invocation = buildCommandInvocation(this.codexExecutable, ["app-server"]);
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
      cwd: this.cwd,
      windowsHide: true,
    });

    this.child = child;
    child.stdout?.on("data", (chunk) => {
      this.handleStdout(chunk.toString());
    });

    child.stderr?.on("data", () => {
      // App-server emits JSON-RPC over stdout. stderr is ignored unless the process exits.
    });

    child.once("error", (error) => {
      this.failAllPending(error);
    });

    child.once("close", (code) => {
      this.failAllPending(new Error(`codex app-server exited with code ${code}`));
      this.child = null;
      this.initializePromise = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "cc-telegram-bridge",
        title: "cc-telegram-bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk;

    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "Unknown app-server error"));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method === "item/agentMessage/delta") {
      const threadId = this.readString(parsed.params?.threadId);
      const delta = this.readString(parsed.params?.delta);
      if (threadId && delta) {
        this.pendingTurns.get(threadId)?.chunks.push(delta);
      }
      return;
    }

    if (parsed.method === "item/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      const pending = threadId ? this.pendingTurns.get(threadId) : undefined;
      const item = parsed.params?.item;
      if (
        pending &&
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type?: unknown }).type === "agentMessage" &&
        "text" in item &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        pending.finalText = (item as { text: string }).text;
      }
      return;
    }

    if (parsed.method === "turn/completed") {
      const threadId = this.readString(parsed.params?.threadId);
      if (!threadId) {
        return;
      }

      const pending = this.pendingTurns.get(threadId);
      if (!pending) {
        return;
      }

      this.pendingTurns.delete(threadId);
      const text = pending.finalText ?? pending.chunks.join("");
      pending.resolve(text);
      return;
    }
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child?.stdin) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.child!.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }) + "\n",
      );
    });
  }

  private async startThread(): Promise<string> {
    const result = (await this.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })) as { thread?: { id?: string } };

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server did not return a thread id");
    }

    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async ensureThreadLoaded(threadId: string): Promise<string> {
    if (this.loadedThreads.has(threadId)) {
      return threadId;
    }

    const result = (await this.request("thread/resume", {
      threadId,
    })) as { thread?: { id?: string } };
    const resumedThreadId = result.thread?.id;

    if (!resumedThreadId) {
      throw new Error(`codex app-server could not resume thread ${threadId}`);
    }

    this.loadedThreads.add(resumedThreadId);
    return resumedThreadId;
  }

  private async startTurn(threadId: string, prompt: string): Promise<string> {
    const pending = await new Promise<string>((resolve, reject) => {
      this.pendingTurns.set(threadId, { chunks: [], resolve, reject });
      this.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: prompt,
            text_elements: [],
          },
        ],
      }).catch((error) => {
        this.pendingTurns.delete(threadId);
        reject(error);
      });
    });

    return pending;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const pending of this.pendingTurns.values()) {
      pending.reject(error);
    }
    this.pendingTurns.clear();
    this.loadedThreads.clear();
  }
}
