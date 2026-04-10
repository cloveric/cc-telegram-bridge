import { rm } from "node:fs/promises";
import path from "node:path";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { FileWorkflowStore, type FileWorkflowRecord } from "../state/file-workflow-store.js";

export interface TaskCommandEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}

function resolveTaskStateDir(env: TaskCommandEnv, instanceName: string): string {
  return resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizeInstanceName(instanceName),
  });
}

function resolveTaskWorkspaceDir(env: TaskCommandEnv, instanceName: string, uploadId: string): string {
  return path.join(resolveTaskStateDir(env, instanceName), "workspace", ".telegram-files", uploadId);
}

export async function listTasks(env: TaskCommandEnv, instanceName: string): Promise<FileWorkflowRecord[]> {
  const store = new FileWorkflowStore(resolveTaskStateDir(env, instanceName));
  return await store.list();
}

export async function clearTask(env: TaskCommandEnv, instanceName: string, uploadId: string): Promise<boolean> {
  const stateDir = resolveTaskStateDir(env, instanceName);
  const store = new FileWorkflowStore(stateDir);
  const record = await store.find(uploadId);

  if (!record) {
    return false;
  }

  await rm(resolveTaskWorkspaceDir(env, instanceName, uploadId), { recursive: true, force: true });
  return await store.remove(uploadId);
}
