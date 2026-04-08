import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";

type SpawnOptions = {
  stdio: ["ignore", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: { toString(): string } | string) => void): void;
};

type ProcessChildLike = {
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => ProcessChildLike;
const MAX_INSTRUCTIONS_CHARS = 16_000;

type CodexJsonEvent =
  | {
      type: "thread.started";
      thread_id: string;
    }
  | {
      type: "item.completed";
      item?: {
        type?: string;
        text?: string;
      };
    };

function parseJsonEvents(stdout: string): CodexJsonEvent[] {
  const events: CodexJsonEvent[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as CodexJsonEvent);
    } catch {
      // Ignore non-JSON lines such as CLI notes.
    }
  }

  return events;
}

function extractThreadId(events: CodexJsonEvent[]): string | null {
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return event.thread_id;
    }
  }

  return null;
}

function extractLastAgentMessage(events: CodexJsonEvent[]): string | null {
  let lastMessage: string | null = null;

  for (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      lastMessage = event.item.text;
    }
  }

  return lastMessage;
}

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  if (/\.(cmd|bat)$/i.test(command)) {
    const escaped = [command, ...args].map((part) => `"${part.replace(/"/g, '\\"')}"`).join(" ");
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", escaped],
    };
  }

  if (/\.ps1$/i.test(command)) {
    return {
      command: "pwsh",
      args: ["-NoProfile", "-File", command, ...args],
    };
  }

  return { command, args, shell: false };
}

export class ProcessCodexAdapter implements CodexAdapter {
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;
  private readonly instructionsPath: string | undefined;

  /**
   * First-pass adapter that runs Codex as a process.
   * The returned session id is a logical Telegram binding key for now, not
   * persisted Codex conversation continuity.
   *
   * If instructionsPath is provided, the file contents are prepended to every
   * prompt sent to Codex (loaded fresh on each call so edits take effect
   * without restarting the service).
   */
  constructor(
    private readonly codexExecutable: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnCodex,
    spawnCodexArg?: SpawnCodex,
    instructionsPath?: string,
  ) {
    this.childEnv =
      typeof childEnvOrSpawn === "function"
        ? (() => {
            const env = { ...process.env };
            delete env.TELEGRAM_BOT_TOKEN;
            return env;
          })()
        : childEnvOrSpawn ?? (() => {
            const env = { ...process.env };
            delete env.TELEGRAM_BOT_TOKEN;
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

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }

    try {
      const content = await readFile(this.instructionsPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        return null;
      }

      if (trimmed.length <= MAX_INSTRUCTIONS_CHARS) {
        return trimmed;
      }

      return `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      return null;
    }
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const instructions = input.instructions ?? (this.instructionsPath ? await this.loadInstructions() : null);
    const parts: string[] = [];
    if (instructions) {
      parts.push(`[System Instructions]\n${instructions}\n[End Instructions]`);
    }
    parts.push(input.text);
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    const prompt = parts.join("\n");
    const args = isLogicalTelegramSessionId(sessionId)
      ? ["exec", "--json", prompt]
      : ["exec", "resume", "--json", sessionId, prompt];
    const result = await this.runCodexJsonCommand(args);
    const events = parseJsonEvents(result.stdout);
    const lastAgentMessage = extractLastAgentMessage(events);
    const threadId = extractThreadId(events);

    return {
      text: lastAgentMessage?.trim() || `Session ${sessionId} completed.`,
      sessionId: threadId ?? undefined,
    };
  }

  private async runCodexJsonCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const invocation = buildCommandInvocation(this.codexExecutable, args);
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: invocation.shell,
      env: this.childEnv,
    });

    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(new Error(stderr.trim() || `codex exited with code ${code}`));
      });
    });
  }
}
