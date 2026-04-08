import { existsSync } from "node:fs";
import path from "node:path";

import { normalizeInstanceName } from "./instance.js";
import type { AppConfig } from "./types.js";

export interface EnvSource {
  APPDATA?: string;
  USERPROFILE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
}

function resolveDefaultCodexExecutable(env: EnvSource): string {
  if (env.CODEX_EXECUTABLE) {
    return env.CODEX_EXECUTABLE;
  }

  const appData =
    env.APPDATA ??
    (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Roaming") : undefined);

  if (appData) {
    const windowsCodexCmd = path.win32.join(appData, "npm", "codex.cmd");
    if (existsSync(windowsCodexCmd)) {
      return windowsCodexCmd;
    }

    const windowsCodexShim = path.win32.join(appData, "npm", "codex.ps1");
    if (existsSync(windowsCodexShim)) {
      return windowsCodexShim;
    }
  }

  return "codex";
}

export function joinStatePath(base: string, segment: string): string {
  if (base.includes("/") && !base.includes("\\")) {
    return path.posix.join(base, segment);
  }

  return path.win32.join(base, segment);
}

export function resolveInstanceStateDir(
  env: Pick<EnvSource, "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR"> = process.env,
): string {
  const instanceName = normalizeInstanceName(env.CODEX_TELEGRAM_INSTANCE);

  if (env.CODEX_TELEGRAM_STATE_DIR) {
    return env.CODEX_TELEGRAM_STATE_DIR;
  }

  const userProfile = env.USERPROFILE;
  if (!userProfile) {
    throw new Error("USERPROFILE is required");
  }

  return path.win32.join(userProfile, ".codex", "channels", "telegram", instanceName);
}

export function resolveConfig(env: EnvSource = process.env): AppConfig {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const instanceName = normalizeInstanceName(env.CODEX_TELEGRAM_INSTANCE);
  const stateDir = resolveInstanceStateDir(env);

  return {
    instanceName,
    telegramBotToken,
    stateDir,
    inboxDir: joinStatePath(stateDir, "inbox"),
    accessStatePath: joinStatePath(stateDir, "access.json"),
    sessionStatePath: joinStatePath(stateDir, "session.json"),
    runtimeLogPath: joinStatePath(stateDir, "runtime.log"),
    codexExecutable: resolveDefaultCodexExecutable(env),
  };
}
