import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveConfig, resolveInstanceStateDir, type EnvSource } from "./config.js";
import { Bridge } from "./runtime/bridge.js";
import { ProcessCodexAdapter } from "./codex/process-adapter.js";
import { AccessStore } from "./state/access-store.js";
import { appendAuditEvent } from "./state/audit-log.js";
import { SessionStore } from "./state/session-store.js";
import { RuntimeStateStore } from "./state/runtime-state.js";
import { TelegramApi } from "./telegram/api.js";
import { handleNormalizedTelegramMessage, type TelegramDeliveryContext } from "./telegram/delivery.js";
import { normalizeUpdate } from "./telegram/update-normalizer.js";
import { SessionManager } from "./runtime/session-manager.js";
import { normalizeInstanceName } from "./instance.js";
import { ChatQueue } from "./runtime/chat-queue.js";

export interface ServiceDependencies {
  api: TelegramApi;
  bridge: Bridge;
}

export interface TelegramServiceContext extends TelegramDeliveryContext {
  chatQueue?: ChatQueue;
}

export interface ResolvedInstanceEnv extends EnvSource {
  HOME?: string;
  USERPROFILE?: string;
  CODEX_TELEGRAM_INSTANCE: string;
  TELEGRAM_BOT_TOKEN: string;
}

export interface ResolvedBotIdentity {
  firstName: string;
  username?: string;
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

export async function readInstanceBotTokenFromEnvFile(env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR">): Promise<string | null> {
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

export async function readConfiguredBotToken(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN">,
  instanceName: string,
): Promise<string | null> {
  if (env.TELEGRAM_BOT_TOKEN) {
    return env.TELEGRAM_BOT_TOKEN;
  }

  return readInstanceBotTokenFromEnvFile({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_INSTANCE: normalizeInstanceName(instanceName),
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
  });
}

export async function resolveServiceEnvForInstance(env: EnvSource, instanceName: string): Promise<ResolvedInstanceEnv> {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const baseEnv: {
    HOME?: string;
    USERPROFILE?: string;
    CODEX_TELEGRAM_INSTANCE: string;
    CODEX_TELEGRAM_STATE_DIR?: string;
    CODEX_EXECUTABLE?: string;
  } = {
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_EXECUTABLE: env.CODEX_EXECUTABLE,
  };

  const telegramBotToken = await readConfiguredBotToken(
    {
      HOME: env.HOME,
      USERPROFILE: env.USERPROFILE,
      CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
      CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    },
    normalizedInstanceName,
  );
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
  const instructionsPath = path.join(config.stateDir, "agent.md");
  const configPath = path.join(config.stateDir, "config.json");
  const adapter = new ProcessCodexAdapter(config.codexExecutable, undefined, undefined, instructionsPath, configPath);
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

export async function lookupTelegramBotIdentity(api: TelegramApi): Promise<ResolvedBotIdentity> {
  const identity = await api.getMe();
  return {
    firstName: identity.first_name,
    username: identity.username,
  };
}

const defaultChatQueue = new ChatQueue();
const runtimeStateStoreCache = new Map<string, RuntimeStateStore>();

function getRuntimeStateStore(inboxDir: string): RuntimeStateStore {
  const runtimeStatePath = path.join(path.dirname(inboxDir), "runtime-state.json");
  const existing = runtimeStateStoreCache.get(runtimeStatePath);
  if (existing) {
    return existing;
  }

  const store = new RuntimeStateStore(runtimeStatePath);
  runtimeStateStoreCache.set(runtimeStatePath, store);
  return store;
}

function getUpdateId(update: unknown): number | undefined {
  if (typeof update !== "object" || update === null || !("update_id" in update)) {
    return undefined;
  }

  const updateId = (update as { update_id?: unknown }).update_id;
  if (typeof updateId !== "number") {
    return undefined;
  }

  return updateId;
}

function advanceOffset(currentOffset: number | undefined, completedOffset: number | undefined): number | undefined {
  if (completedOffset === undefined) {
    return currentOffset;
  }

  if (currentOffset === undefined) {
    return completedOffset;
  }

  return Math.max(currentOffset, completedOffset);
}

function formatErrorMessage(scope: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${scope}: ${message}`;
}

export async function processTelegramUpdates(
  updates: unknown[],
  context: TelegramServiceContext,
  logger: Pick<Console, "error"> = console,
): Promise<number | undefined> {
  let nextOffset: number | undefined;
  const chatQueue = context.chatQueue ?? defaultChatQueue;
  const runtimeStateStore = getRuntimeStateStore(context.inboxDir);
  const runtimeState = await runtimeStateStore.load();
  let lastHandledUpdateId = runtimeState.lastHandledUpdateId;

  for (const update of updates) {
    const updateId = getUpdateId(update);
    const completedOffset = updateId === undefined ? undefined : updateId + 1;

    try {
      if (updateId !== undefined && lastHandledUpdateId !== null && updateId <= lastHandledUpdateId) {
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          updateId,
          outcome: "duplicate",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      const normalized = normalizeUpdate(update);
      if (!normalized) {
        if (updateId !== undefined) {
          await runtimeStateStore.markHandledUpdateId(updateId);
          lastHandledUpdateId = updateId;
        }
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          updateId,
          outcome: "invalid",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      if (!normalized.text && normalized.attachments.length === 0) {
        if (updateId !== undefined) {
          await runtimeStateStore.markHandledUpdateId(updateId);
          lastHandledUpdateId = updateId;
        }
        await appendAuditEvent(path.dirname(context.inboxDir), {
          type: "update.skip",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId,
          outcome: "empty",
        });
        nextOffset = advanceOffset(nextOffset, completedOffset);
        continue;
      }

      await chatQueue.enqueue(normalized.chatId, () =>
        handleNormalizedTelegramMessage(normalized, {
          ...context,
          updateId,
        }),
      );
      if (updateId !== undefined) {
        await runtimeStateStore.markHandledUpdateId(updateId);
        lastHandledUpdateId = updateId;
      }
      nextOffset = advanceOffset(nextOffset, completedOffset);
    } catch (error) {
      await appendAuditEvent(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        updateId,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
      logger.error(formatErrorMessage("Failed to handle Telegram update", error));
      break;
    }
  }

  return nextOffset;
}

export async function getLastHandledUpdateId(inboxDir: string): Promise<number | null> {
  const runtimeStateStore = getRuntimeStateStore(inboxDir);
  const state = await runtimeStateStore.load();
  return state.lastHandledUpdateId;
}

export async function pollTelegramUpdatesOnce(
  api: TelegramApi,
  bridge: Bridge,
  inboxDir: string,
  logger: Pick<Console, "error"> = console,
  offset?: number,
  signal?: AbortSignal,
): Promise<{ offset: number | undefined; hadFetchError: boolean }> {
  try {
    const updates = await api.getUpdates(offset, signal);
    return {
      offset: await processTelegramUpdates(updates, { api, bridge, inboxDir }, logger),
      hadFetchError: false,
    };
  } catch (error) {
    logger.error(formatErrorMessage("Failed to fetch Telegram updates", error));
    return {
      offset,
      hadFetchError: true,
    };
  }
}

export async function pollTelegramUpdates(
  api: TelegramApi,
  bridge: Bridge,
  inboxDir: string,
  logger: Pick<Console, "error"> = console,
  signal?: AbortSignal,
): Promise<void> {
  let offset: number | undefined;
  let backoffMs = 1000;
  const maxBackoffMs = 60000;

  while (!signal?.aborted) {
    const result = await pollTelegramUpdatesOnce(api, bridge, inboxDir, logger, offset, signal);
    offset = result.offset;

    if (result.hadFetchError) {
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    } else {
      backoffMs = 1000;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
