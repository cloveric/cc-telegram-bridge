import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";
import type { ApprovalMode } from "./process-adapter.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: { toString(): string } | string) => void): void;
};

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
};

type ClaudeChildProcess = {
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnClaude = (command: string, args: string[], options: SpawnOptions) => ClaudeChildProcess;

interface ClaudeJsonResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

const MAX_INSTRUCTIONS_CHARS = 16_000;

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return sessionId.startsWith("telegram-");
}

export class ProcessClaudeAdapter implements CodexAdapter {
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnClaude: SpawnClaude;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly workspacePath: string | undefined;

  constructor(
    private readonly claudeExecutable: string,
    options?: {
      childEnv?: NodeJS.ProcessEnv;
      spawnFn?: SpawnClaude;
      instructionsPath?: string;
      configPath?: string;
      workspacePath?: string;
    },
  ) {
    this.childEnv = options?.childEnv ?? (() => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      return env;
    })();

    this.spawnClaude = options?.spawnFn ?? (spawn as unknown as SpawnClaude);
    this.instructionsPath = options?.instructionsPath;
    this.configPath = options?.configPath;
    this.workspacePath = options?.workspacePath;
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
    } catch {
      return null;
    }
  }

  private async loadApprovalMode(): Promise<ApprovalMode> {
    if (!this.configPath) {
      return "normal";
    }

    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as { approvalMode?: string };
      const mode = parsed.approvalMode;
      if (mode === "full-auto" || mode === "bypass") {
        return mode;
      }
      return "normal";
    } catch {
      return "normal";
    }
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const instructions = input.instructions ?? (this.instructionsPath ? await this.loadInstructions() : null);
    const approvalMode = this.configPath ? await this.loadApprovalMode() : "normal";

    // Build prompt with files
    const parts: string[] = [];
    parts.push(input.text);
    parts.push(...input.files.map((file) => `Attachment: ${file}`));
    const prompt = parts.join("\n");

    // Build args
    const args: string[] = ["-p", "--output-format", "json"];

    // System prompt from agent.md
    if (instructions) {
      args.push("--system-prompt", instructions);
    }

    // Resume existing session
    if (!isLogicalTelegramSessionId(sessionId)) {
      args.push("-r", sessionId);
    }

    // Approval mode
    if (approvalMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (approvalMode === "full-auto") {
      args.push("--permission-mode", "bypassPermissions");
    }

    // Workspace directory (where CLAUDE.md lives)
    if (this.workspacePath) {
      args.push("--add-dir", this.workspacePath);
    }

    const result = await this.runClaudeCommand(args, prompt);
    const parsed = this.parseResult(result.stdout);

    return {
      text: parsed.text,
      sessionId: parsed.sessionId,
    };
  }

  private parseResult(stdout: string): { text: string; sessionId?: string } {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { text: "Claude returned an empty response." };
    }

    try {
      const json = JSON.parse(trimmed) as ClaudeJsonResult;

      if (json.is_error) {
        return { text: `Error: ${json.result ?? "Unknown error"}` };
      }

      return {
        text: json.result?.trim() || "Claude completed the request.",
        sessionId: json.session_id ?? undefined,
      };
    } catch {
      // If not valid JSON, return raw output
      return { text: trimmed };
    }
  }

  private async runClaudeCommand(args: string[], stdinContent: string): Promise<{ stdout: string; stderr: string }> {
    const child = this.spawnClaude(this.claudeExecutable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.childEnv,
      cwd: this.workspacePath,
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

        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      });

      // Write prompt to stdin
      child.stdin?.write(stdinContent, () => {
        child.stdin?.end();
      });
    });
  }
}
