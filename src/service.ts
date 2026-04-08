import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveConfig, resolveInstanceStateDir, type EnvSource } from "./config.js";
import { Bridge } from "./runtime/bridge.js";
import { ProcessCodexAdapter } from "./codex/process-adapter.js";
import { AccessStore } from "./state/access-store.js";
import { SessionStore } from "./state/session-store.js";
import { TelegramApi } from "./telegram/api.js";
import { normalizeUpdate } from "./telegram/update-normalizer.js";
import { SessionManager } from "./runtime/session-manager.js";
import { normalizeInstanceName } from "./instance.js";

export interface ServiceDependencies {
  api: TelegramApi;
  bridge: Bridge;
}

export interface ResolvedInstanceEnv extends EnvSource {
  USERPROFILE?: string;
  CODEX_TELEGRAM_INSTANCE: string;
  TELEGRAM_BOT_TOKEN: string;
}

export function parseServiceInstanceName(argv: string[]): string {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--instance") {
      if (index + 1 >= argv.length) {
        throw new Error("Invalid instance name");
      }

      return normalizeInstanceName(argv[index + 1]);
    }

    if (argument.startsWith("--instance=")) {
      return normalizeInstanceName(argument.slice("--instance=".length));
    }
  }

  return "default";
}

function parseDotEnvValue(rawLine: string): string | null {
  const trimmed = rawLine.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (key !== "TELEGRAM_BOT_TOKEN") {
    return null;
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  if (!rawValue) {
    return null;
  }

  if (rawValue.startsWith("\"")) {
    return JSON.parse(rawValue) as string;
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
}

export async function readInstanceBotTokenFromEnvFile(env: Pick<EnvSource, "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR">): Promise<string | null> {
  const stateDir = resolveInstanceStateDir(env);
  const envPath = path.join(stateDir, ".env");

  try {
    const contents = await readFile(envPath, "utf8");

    for (const line of contents.split(/\r?\n/)) {
      const token = parseDotEnvValue(line);
      if (token !== null) {
        return token;
      }
    }
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return null;
}

export async function resolveServiceEnvForInstance(env: EnvSource, instanceName: string): Promise<ResolvedInstanceEnv> {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const baseEnv: {
    USERPROFILE?: string;
    CODEX_TELEGRAM_INSTANCE: string;
    CODEX_TELEGRAM_STATE_DIR?: string;
    CODEX_EXECUTABLE?: string;
  } = {
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_EXECUTABLE: env.CODEX_EXECUTABLE,
  };

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN ?? (await readInstanceBotTokenFromEnvFile(baseEnv));
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return {
    ...baseEnv,
    TELEGRAM_BOT_TOKEN: telegramBotToken,
  };
}

export async function createServiceDependencies(env: EnvSource): Promise<{ config: ReturnType<typeof resolveConfig>; api: TelegramApi; bridge: Bridge }> {
  const config = resolveConfig(env);
  const api = new TelegramApi(config.telegramBotToken);
  const accessStore = new AccessStore(config.accessStatePath);
  const sessionStore = new SessionStore(config.sessionStatePath);
  const adapter = new ProcessCodexAdapter(config.codexExecutable);
  const sessionManager = new SessionManager(sessionStore, adapter);
  const bridge = new Bridge(accessStore, sessionManager, adapter);

  return { config, api, bridge };
}

export async function createServiceDependenciesForInstance(
  env: EnvSource,
  instanceName: string,
): Promise<{ config: ReturnType<typeof resolveConfig>; api: TelegramApi; bridge: Bridge }> {
  return createServiceDependencies(await resolveServiceEnvForInstance(env, instanceName));
}

function getLastUpdateOffset(updates: unknown[], fallbackOffset?: number): number | undefined {
  if (updates.length === 0) {
    return fallbackOffset;
  }

  const lastUpdate = updates[updates.length - 1];
  if (typeof lastUpdate !== "object" || lastUpdate === null || !("update_id" in lastUpdate)) {
    return fallbackOffset;
  }

  const updateId = (lastUpdate as { update_id?: unknown }).update_id;
  if (typeof updateId !== "number") {
    return fallbackOffset;
  }

  return updateId + 1;
}

function formatErrorMessage(scope: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${scope}: ${message}`;
}

export async function processTelegramUpdates(
  updates: unknown[],
  bridge: Bridge,
  logger: Pick<Console, "error"> = console,
): Promise<void> {
  for (const update of updates) {
    try {
      const normalized = normalizeUpdate(update);
      if (!normalized || !normalized.text) {
        continue;
      }

      await bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        text: normalized.text,
        files: [],
      });
    } catch (error) {
      logger.error(formatErrorMessage("Failed to handle Telegram update", error));
    }
  }
}

export async function pollTelegramUpdatesOnce(
  api: TelegramApi,
  bridge: Bridge,
  logger: Pick<Console, "error"> = console,
  offset?: number,
): Promise<number | undefined> {
  try {
    const updates = await api.getUpdates(offset);
    await processTelegramUpdates(updates, bridge, logger);
    return getLastUpdateOffset(updates, offset);
  } catch (error) {
    logger.error(formatErrorMessage("Failed to fetch Telegram updates", error));
    return offset;
  }
}

export async function pollTelegramUpdates(api: TelegramApi, bridge: Bridge, logger: Pick<Console, "error"> = console): Promise<void> {
  let offset: number | undefined;

  for (;;) {
    offset = await pollTelegramUpdatesOnce(api, bridge, logger, offset);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
