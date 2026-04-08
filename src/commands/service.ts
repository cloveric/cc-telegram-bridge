import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { resolveInstanceLockPath, type InstanceLockRecord } from "../state/instance-lock.js";
import { AccessStore } from "../state/access-store.js";
import { TelegramApi } from "../telegram/api.js";
import { getLastHandledUpdateId, lookupTelegramBotIdentity, readConfiguredBotToken } from "../service.js";

export interface ServiceCommandEnv
  extends Pick<EnvSource, "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN"> {}

export interface ServiceCommandDeps {
  cwd?: string;
  isProcessAlive?: (pid: number) => boolean;
  isExpectedServiceProcess?: (pid: number, entryPath: string, instanceName: string) => boolean;
  spawnDetached?: (command: string, args: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
  killProcessTree?: (pid: number) => void;
  readConfiguredBotToken?: (env: ServiceCommandEnv, instanceName: string) => Promise<string | null>;
  fetchTelegramBotIdentity?: (botToken: string) => Promise<{ firstName: string; username?: string }>;
}

export interface ServicePaths {
  instanceName: string;
  stateDir: string;
  lockPath: string;
  stdoutPath: string;
  stderrPath: string;
  entryPath: string;
}

export interface ServiceStatus {
  instanceName: string;
  running: boolean;
  pid: number | null;
  lockPath: string;
  stateDir: string;
  stdoutPath: string;
  stderrPath: string;
  policy: string;
  pairedUsers: number;
  allowlistCount: number;
  pendingPairs: number;
  lastHandledUpdateId: number | null;
  botTokenConfigured: boolean;
  botIdentity?: {
    firstName: string;
    username?: string;
  };
  botIdentityWarning?: string;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }

      if (code === "EPERM") {
        return true;
      }
    }

    throw error;
  }
}

function defaultIsExpectedServiceProcess(pid: number, entryPath: string, instanceName: string): boolean {
  const relativeEntryPath = path.win32.relative(process.cwd(), entryPath).replace(/\\/g, "/");
  const encoded = Buffer.from(
    `
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";
      if ($null -eq $proc) { exit 1 }
      $cmd = $proc.CommandLine;
      if (
        ($cmd -like "*${entryPath.replace(/\\/g, "\\\\")}*" -or $cmd -like "*${relativeEntryPath}*" -or $cmd -like "*dist/src/index.js*") -and
        $cmd -like "*--instance ${instanceName}*"
      ) { exit 0 }
      exit 1
    `,
    "utf16le",
  ).toString("base64");

  const result = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", encoded], {
    windowsHide: true,
  });

  return result.status === 0;
}

function defaultSpawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultKillProcessTree(pid: number): void {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Failed to stop pid ${pid}`).trim());
  }
}

async function readLockRecord(lockPath: string): Promise<InstanceLockRecord | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof (parsed as InstanceLockRecord).pid === "number" &&
      "token" in parsed &&
      typeof (parsed as InstanceLockRecord).token === "string"
    ) {
      return parsed as InstanceLockRecord;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
  }

  return null;
}

export function resolveServicePaths(
  env: ServiceCommandEnv,
  instanceName: string,
  cwd: string,
): ServicePaths {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return {
    instanceName: normalizedInstanceName,
    stateDir,
    lockPath: resolveInstanceLockPath(stateDir),
    stdoutPath: path.join(stateDir, "service.stdout.log"),
    stderrPath: path.join(stateDir, "service.stderr.log"),
    entryPath: path.join(cwd, "dist", "src", "index.js"),
  };
}

export async function startServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const spawnDetachedProcess = deps.spawnDetached ?? defaultSpawnDetached;
  const sleep = deps.sleep ?? defaultSleep;

  if (!existsSync(paths.entryPath)) {
    throw new Error(`Built entrypoint not found: ${paths.entryPath}`);
  }

  const existingLock = await readLockRecord(paths.lockPath);
  if (
    existingLock !== null &&
    isProcessAlive(existingLock.pid) &&
    isExpectedServiceProcess(existingLock.pid, paths.entryPath, paths.instanceName)
  ) {
    throw new Error(`Instance "${paths.instanceName}" is already running with pid ${existingLock.pid}.`);
  }

  await mkdir(paths.stateDir, { recursive: true });

  const command = "pwsh";
  const script = [
    `Set-Location '${cwd.replace(/'/g, "''")}'`,
    `node '${paths.entryPath.replace(/'/g, "''")}' --instance ${paths.instanceName}`,
    `1>> '${paths.stdoutPath.replace(/'/g, "''")}'`,
    `2>> '${paths.stderrPath.replace(/'/g, "''")}'`,
  ].join("; ");

  spawnDetachedProcess(command, ["-NoProfile", "-Command", script]);

  for (let attempt = 0; attempt < 20; attempt++) {
    const lock = await readLockRecord(paths.lockPath);
    if (
      lock !== null &&
      isProcessAlive(lock.pid) &&
      isExpectedServiceProcess(lock.pid, paths.entryPath, paths.instanceName)
    ) {
      return `Started instance "${paths.instanceName}" with pid ${lock.pid}.`;
    }

    await sleep(250);
  }

  throw new Error(`Instance "${paths.instanceName}" did not reach a running state.`);
}

export async function stopServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const killProcessTree = deps.killProcessTree ?? defaultKillProcessTree;

  const existingLock = await readLockRecord(paths.lockPath);
  if (
    existingLock === null ||
    !isProcessAlive(existingLock.pid) ||
    !isExpectedServiceProcess(existingLock.pid, paths.entryPath, paths.instanceName)
  ) {
    return `Instance "${paths.instanceName}" is not running.`;
  }

  killProcessTree(existingLock.pid);
  return `Stopped instance "${paths.instanceName}".`;
}

export async function getServiceStatus(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<ServiceStatus> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const lockRecord = await readLockRecord(paths.lockPath);
  const pid = lockRecord?.pid ?? null;
  const running =
    pid !== null &&
    isProcessAlive(pid) &&
    isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName);
  const accessStore = new AccessStore(path.join(paths.stateDir, "access.json"));
  const accessStatus = await accessStore.getStatus();
  const lastHandledUpdateId = await getLastHandledUpdateId(path.join(paths.stateDir, "inbox"));
  const readToken = deps.readConfiguredBotToken ?? readConfiguredBotToken;
  const fetchIdentity =
    deps.fetchTelegramBotIdentity ??
    (async (botToken: string): Promise<{ firstName: string; username?: string }> => {
      const api = new TelegramApi(botToken);
      return lookupTelegramBotIdentity(api);
    });
  const botToken = await readToken(env, paths.instanceName);
  let botIdentity: { firstName: string; username?: string } | undefined;
  let botIdentityWarning: string | undefined;

  if (botToken) {
    try {
      botIdentity = await fetchIdentity(botToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      botIdentityWarning = `Bot identity lookup failed: ${message}`;
    }
  }

  return {
    instanceName: paths.instanceName,
    running,
    pid: running ? pid : null,
    lockPath: paths.lockPath,
    stateDir: paths.stateDir,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    policy: accessStatus.policy,
    pairedUsers: accessStatus.pairedUsers,
    allowlistCount: accessStatus.allowlist.length,
    pendingPairs: accessStatus.pendingPairs.length,
    lastHandledUpdateId,
    botTokenConfigured: botToken !== null,
    botIdentity,
    botIdentityWarning,
  };
}
