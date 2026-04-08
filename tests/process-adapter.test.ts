import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";

describe("ProcessCodexAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ProcessCodexAdapter("codex");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("passes attachments into the generated prompt", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { stdio: ["ignore", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv };
    }> = [];
    const child = new FakeChildProcess();
    const spawnCodex = (
      command: string,
      args: string[],
      options: { stdio: ["ignore", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ command, args, options });
      return child;
    };

    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.png", "b.pdf"],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.close(0);

    await promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "Hello\nAttachment: a.png\nAttachment: b.pdf"],
      options: { stdio: ["ignore", "pipe", "pipe"], shell: false },
    });
    expect(calls[0]?.options.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("returns trimmed stdout when codex exits successfully", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(
      '{"type":"item.completed","item":{"type":"agent_message","text":"  answer from codex  "}}\n',
    );
    child.close(0);

    await expect(promise).resolves.toEqual({ text: "answer from codex" });
  });

  it("falls back when codex returns empty stdout", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Session thread-123 completed.",
    });
  });

  it("returns a newly created thread id on the first real user message", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"Hello back"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Hello back",
      sessionId: "thread-123",
    });
  });

  it("rejects with stderr text on nonzero exit", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stderr.emitData("codex failed\n");
    child.close(2);

    await expect(promise).rejects.toThrow("codex failed");
  });
});

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
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
    options: { stdio: ["ignore", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv };
  }> = [];
  const spawnCodex = (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, options });
    return child;
  };

  return { spawnCodex, child, calls };
}
