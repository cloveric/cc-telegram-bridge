import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Condition was not met in time");
}

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  lines: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) {
      this.lines.push(text);
    }
    callback?.(null);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const child = new FakeChildProcess();
  const calls: Array<{
    command: string;
    args: string[];
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    };
  }> = [];

  const spawnFn = (
    command: string,
    args: string[],
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    },
  ) => {
    calls.push({ command, args, options });
    return child;
  };

  return { child, calls, spawnFn };
}

describe("CodexAppServerAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new CodexAppServerAdapter("codex", process.cwd());
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("starts a persistent thread for a logical session and returns the real thread id", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.txt"],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    expect(initialize.method).toBe("initialize");
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-123");
    expect(turnStart.params.input).toEqual([
      {
        type: "text",
        text: "Hello\nAttachment: a.txt",
        text_elements: [],
      },
    ]);

    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-123","delta":"READY"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY",
      sessionId: "thread-123",
    });
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toEqual(["app-server"]);
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("loads instructions from agent.md and isolates CODEX_HOME", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const engineHomePath = path.join(root, "engine-home");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
        engineHomePath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toBe("[System Instructions]\nYou are isolated.\n[End Instructions]\nHello");
      expect(calls[0]?.options.env?.CODEX_HOME).toBe(engineHomePath);

      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses an existing thread without starting a new one", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-abc", {
      text: "Next",
      files: [],
      instructions: "Be concise.",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume.method).toBe("thread/resume");
    expect(resume.params.threadId).toBe("thread-abc");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-abc");
    expect(turnStart.params.input[0].text).toBe("[System Instructions]\nBe concise.\n[End Instructions]\nNext");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "done",
    });
  });

  it("does not resume a thread twice once it is loaded", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("thread-abc", {
      text: "First",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-1"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await first;

    const second = adapter.sendUserMessage("thread-abc", {
      text: "Second",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 4);
    const nextRequest = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(nextRequest.method).toBe("turn/start");
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-2"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toEqual({
      text: "done-2",
    });
  });
});
