import { spawn } from "node:child_process";

import type { CodexAdapter, CodexAdapterResponse, CodexSessionHandle } from "./adapter.js";

export class ProcessCodexAdapter implements CodexAdapter {
  constructor(private readonly codexExecutable: string) {}

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async sendUserMessage(
    sessionId: string,
    input: { text: string; files: string[] },
  ): Promise<CodexAdapterResponse> {
    const prompt = [input.text, ...input.files.map((file) => `Attachment: ${file}`)].join("\n");
    const child = spawn(this.codexExecutable, ["exec", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    return await new Promise<CodexAdapterResponse>((resolve, reject) => {
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
          resolve({ text: stdout.trim() || `Session ${sessionId} completed.` });
          return;
        }

        reject(new Error(stderr.trim() || `codex exited with code ${code}`));
      });
    });
  }
}
