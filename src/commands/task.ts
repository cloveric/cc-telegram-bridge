import { rm } from "node:fs/promises";
import path from "node:path";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import {
  FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
  FileWorkflowStore,
  type FileWorkflowRecord,
} from "../state/file-workflow-store.js";

export interface TaskCommandEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}

interface ClearTaskDeps {
  removeRecord?: (store: FileWorkflowStore, uploadId: string) => Promise<boolean>;
  removeWorkspaceDir?: (workspaceDir: string) => Promise<void>;
}

export interface ClearTaskResult {
  cleared: boolean;
  repaired: boolean;
  cleanupWarning?: string;
}

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

function resolveTaskWorkspaceRoot(env: TaskCommandEnv, instanceName: string): string {
  return path.join(resolveTaskStateDir(env, instanceName), "workspace", ".telegram-files");
}

function isSingleWorkspaceChildName(uploadId: string): boolean {
  if (
    uploadId.length === 0 ||
    uploadId === "." ||
    uploadId === ".." ||
    uploadId.includes("/") ||
    uploadId.includes("\\")
  ) {
    return false;
  }

  return path.basename(uploadId) === uploadId && path.normalize(uploadId) === uploadId;
}

export async function listTasks(
  env: TaskCommandEnv,
  instanceName: string,
): Promise<{ tasks: FileWorkflowRecord[]; warning?: string }> {
  const store = new FileWorkflowStore(resolveTaskStateDir(env, instanceName));
  const { state, warning } = await store.inspect();
  return {
    tasks: [...state.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warning,
  };
}

export async function inspectTask(
  env: TaskCommandEnv,
  instanceName: string,
  uploadId: string,
): Promise<{ task: FileWorkflowRecord | null; warning?: string }> {
  const store = new FileWorkflowStore(resolveTaskStateDir(env, instanceName));
  const { record, warning } = await store.findSafe(uploadId);

  return {
    task: record,
    warning,
  };
}

export async function clearTask(env: TaskCommandEnv, instanceName: string, uploadId: string): Promise<boolean> {
  return (await clearTaskWithRecovery(env, instanceName, uploadId)).cleared;
}

export async function clearTaskWithRecovery(
  env: TaskCommandEnv,
  instanceName: string,
  uploadId: string,
  deps: ClearTaskDeps = {},
): Promise<ClearTaskResult> {
  const stateDir = resolveTaskStateDir(env, instanceName);
  const store = new FileWorkflowStore(stateDir);
  const { record, warning } = await store.findSafe(uploadId);

  if (warning === FILE_WORKFLOW_STATE_UNREADABLE_WARNING) {
    await store.reset();
    return {
      cleared: false,
      repaired: true,
    };
  }

  if (!record) {
    return {
      cleared: false,
      repaired: false,
    };
  }

  const removeRecord = deps.removeRecord ?? ((workflowStore, workflowUploadId) => workflowStore.remove(workflowUploadId));
  const removeWorkspaceDir = deps.removeWorkspaceDir ?? (async (workspaceDir: string) => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const cleared = await removeRecord(store, uploadId);
  if (!cleared) {
    return {
      cleared: false,
      repaired: false,
    };
  }

  if (isSingleWorkspaceChildName(record.uploadId)) {
    const workspaceDir = path.resolve(resolveTaskWorkspaceDir(env, instanceName, record.uploadId));
    try {
      await removeWorkspaceDir(workspaceDir);
    } catch (error) {
      return {
        cleared: true,
        repaired: false,
        cleanupWarning: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    cleared: true,
    repaired: false,
  };
}

export { FILE_WORKFLOW_STATE_UNREADABLE_WARNING };
