import { spawn } from "node:child_process";

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

function requiresShell(command: string): boolean {
  return /\.cmd$/i.test(command) || /\.bat$/i.test(command) || /\.ps1$/i.test(command);
}

export class ProcessCodexAdapter implements CodexAdapter {
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;

  /**
   * First-pass adapter that runs Codex as a process.
   * The returned session id is a logical Telegram binding key for now, not
   * persisted Codex conversation continuity.
   */
  constructor(
    private readonly codexExecutable: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnCodex,
    spawnCodexArg?: SpawnCodex,
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
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const prompt = [input.text, ...input.files.map((file) => `Attachment: ${file}`)].join("\n");
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
    const child = this.spawnCodex(this.codexExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: requiresShell(this.codexExecutable),
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
