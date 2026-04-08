import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseServiceInstanceName, readInstanceBotTokenFromEnvFile } from "../src/service.js";

describe("parseServiceInstanceName", () => {
  it("defaults to the default instance", () => {
    expect(parseServiceInstanceName([])).toBe("default");
  });

  it("reads a named instance from --instance", () => {
    expect(parseServiceInstanceName(["--instance", "alpha"])).toBe("alpha");
  });

  it("reads a named instance from --instance=", () => {
    expect(parseServiceInstanceName(["--instance=beta"])).toBe("beta");
  });
});

describe("readInstanceBotTokenFromEnvFile", () => {
  it("reads TELEGRAM_BOT_TOKEN from the instance .env file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const envPath = path.join(root, ".codex", "channels", "telegram", "alpha", ".env");

    try {
      await mkdir(path.dirname(envPath), { recursive: true });
      await writeFile(envPath, 'TELEGRAM_BOT_TOKEN="secret-token"\n', "utf8");

      await expect(
        readInstanceBotTokenFromEnvFile({
          USERPROFILE: root,
          CODEX_TELEGRAM_INSTANCE: "alpha",
        }),
      ).resolves.toBe("secret-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
