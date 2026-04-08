import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { joinStatePath, resolveInstanceStateDir } from "../config.js";

export interface InstanceTokenEnv {
  USERPROFILE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
}

export interface PersistedInstanceToken {
  instanceName: string;
  stateDir: string;
  envPath: string;
}

export async function writeInstanceBotToken(
  env: InstanceTokenEnv,
  instanceName: string,
  botToken: string,
): Promise<PersistedInstanceToken> {
  const stateDir = resolveInstanceStateDir({
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
  const envPath = joinStatePath(stateDir, ".env");

  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, `TELEGRAM_BOT_TOKEN=${JSON.stringify(botToken)}\n`, "utf8");

  return { instanceName, stateDir, envPath };
}
