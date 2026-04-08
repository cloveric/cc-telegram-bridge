import path from "node:path";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { SessionStore } from "../state/session-store.js";

export interface SessionCommandEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}

function resolveSessionStatePath(env: SessionCommandEnv, instanceName: string): string {
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizeInstanceName(instanceName),
  });

  return path.join(stateDir, "session.json");
}

export async function listSessions(
  env: SessionCommandEnv,
  instanceName: string,
): Promise<Array<{ chatId: number; threadId: string; status: string; updatedAt: string }>> {
  const store = new SessionStore(resolveSessionStatePath(env, instanceName));
  const state = await store.load();

  return state.chats
    .map((record) => ({
      chatId: record.telegramChatId,
      threadId: record.codexSessionId,
      status: record.status,
      updatedAt: record.updatedAt,
    }))
    .sort((a, b) => a.chatId - b.chatId);
}

export async function getSessionForChat(
  env: SessionCommandEnv,
  instanceName: string,
  chatId: number,
): Promise<{ chatId: number; threadId: string; status: string; updatedAt: string } | null> {
  const store = new SessionStore(resolveSessionStatePath(env, instanceName));
  const record = await store.findByChatId(chatId);

  if (!record) {
    return null;
  }

  return {
    chatId: record.telegramChatId,
    threadId: record.codexSessionId,
    status: record.status,
    updatedAt: record.updatedAt,
  };
}
