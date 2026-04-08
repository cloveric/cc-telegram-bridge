import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("uses the default Windows-first state directory under the user profile", () => {
    const config = resolveConfig({
      USERPROFILE: "C:\\Users\\hangw",
      TELEGRAM_BOT_TOKEN: "abc123",
    });

    expect(config.stateDir).toBe("C:\\Users\\hangw\\.codex\\channels\\telegram");
    expect(config.inboxDir).toBe("C:\\Users\\hangw\\.codex\\channels\\telegram\\inbox");
    expect(config.telegramBotToken).toBe("abc123");
  });

  it("throws when USERPROFILE is missing", () => {
    expect(() =>
      resolveConfig({
        TELEGRAM_BOT_TOKEN: "abc123",
      }),
    ).toThrow("USERPROFILE is required");
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    expect(() =>
      resolveConfig({
        USERPROFILE: "C:\\Users\\hangw",
      }),
    ).toThrow("TELEGRAM_BOT_TOKEN is required");
  });

  it("respects the state directory and executable overrides", () => {
    const config = resolveConfig({
      USERPROFILE: "C:\\Users\\hangw",
      TELEGRAM_BOT_TOKEN: "abc123",
      CODEX_TELEGRAM_STATE_DIR: "C:/custom/state",
      CODEX_EXECUTABLE: "codex.exe",
    });

    expect(config.stateDir).toBe("C:/custom/state");
    expect(config.inboxDir).toBe("C:/custom/state/inbox");
    expect(config.accessStatePath).toBe("C:/custom/state/access.json");
    expect(config.sessionStatePath).toBe("C:/custom/state/session.json");
    expect(config.runtimeLogPath).toBe("C:/custom/state/runtime.log");
    expect(config.codexExecutable).toBe("codex.exe");
  });

  it("defaults the codex executable to codex", () => {
    const config = resolveConfig({
      USERPROFILE: "C:\\Users\\hangw",
      TELEGRAM_BOT_TOKEN: "abc123",
    });

    expect(config.codexExecutable).toBe("codex");
  });
});
