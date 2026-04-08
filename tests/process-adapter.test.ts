import { describe, expect, it } from "vitest";

import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";

describe("ProcessCodexAdapter", () => {
  it("creates telegram-scoped sessions", async () => {
    const adapter = new ProcessCodexAdapter("codex");
    const session = await adapter.createSession(12345);

    expect(session.sessionId).toBe("telegram-12345");
  });
});
