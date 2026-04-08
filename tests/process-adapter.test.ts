import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";

describe("ProcessCodexAdapter", () => {
  it("creates a real codex thread-backed session", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const promise = adapter.createSession(12345);

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"READY"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({ sessionId: "thread-123" });
    expect(calls).toEqual([
      {
        command: "codex",
        args: ["exec", "--json", "Reply with exactly READY"],
      },
    ]);
  });

  it("passes attachments into the generated prompt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const child = new FakeChildProcess();
    const spawnCodex = (
      command: string,
      args: string[],
      _options: { stdio: ["ignore", "pipe", "pipe"] },
    ) => {
      calls.push({ command, args });
      return child;
    };

    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: ["a.png", "b.pdf"],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.close(0);

    await promise;

    expect(calls).toEqual([
      {
        command: "codex",
        args: ["exec", "resume", "--json", "thread-123", "Hello\nAttachment: a.png\nAttachment: b.pdf"],
      },
    ]);
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
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnCodex = (
    command: string,
    args: string[],
    _options: { stdio: ["ignore", "pipe", "pipe"] },
  ) => {
    calls.push({ command, args });
    return child;
  };

  return { spawnCodex, child, calls };
}
