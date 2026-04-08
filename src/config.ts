import path from "node:path";

import type { AppConfig } from "./types.js";

export interface EnvSource {
  USERPROFILE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
}

function joinStatePath(base: string, segment: string): string {
  if (base.includes("/") && !base.includes("\\")) {
    return path.posix.join(base, segment);
  }

  return path.win32.join(base, segment);
}

export function resolveConfig(env: EnvSource = process.env): AppConfig {
  const userProfile = env.USERPROFILE;
  if (!userProfile) {
    throw new Error("USERPROFILE is required");
  }

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const stateDir =
    env.CODEX_TELEGRAM_STATE_DIR ??
    path.win32.join(userProfile, ".codex", "channels", "telegram");

  return {
    telegramBotToken,
    stateDir,
    inboxDir: joinStatePath(stateDir, "inbox"),
    accessStatePath: joinStatePath(stateDir, "access.json"),
    sessionStatePath: joinStatePath(stateDir, "session.json"),
    runtimeLogPath: joinStatePath(stateDir, "runtime.log"),
    codexExecutable: env.CODEX_EXECUTABLE ?? "codex",
  };
}
