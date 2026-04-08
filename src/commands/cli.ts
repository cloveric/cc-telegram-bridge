import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { AccessStore } from "../state/access-store.js";
import { normalizeInstanceName } from "../instance.js";
import { resolveInstanceAccessStatePath, type InstanceTokenEnv, writeInstanceBotToken } from "./access.js";
import { appendAuditEvent } from "../state/audit-log.js";
import {
  getServiceLogs,
  getServiceStatus,
  startServiceInstance,
  stopServiceInstance,
  type ServiceCommandDeps,
} from "./service.js";

export interface CliLogger {
  log: (message: string) => void;
}

export interface CliOptions {
  env?: Pick<EnvSource, "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN">;
  logger?: CliLogger;
  serviceDeps?: ServiceCommandDeps;
}

function normalizeCommandArgs(argv: string[]): string[] {
  if (argv[0] === "telegram") {
    return argv.slice(1);
  }

  return argv;
}

function extractInstanceOption(argv: string[]): { instanceName: string; args: string[] } {
  let instanceName = "default";
  const args: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--instance") {
      if (index + 1 >= argv.length) {
        throw new Error("Invalid instance name");
      }

      instanceName = normalizeInstanceName(argv[index + 1]);
      index++;
      continue;
    }

    if (argument.startsWith("--instance=")) {
      instanceName = normalizeInstanceName(argument.slice("--instance=".length));
      continue;
    }

    args.push(argument);
  }

  return { instanceName, args };
}

function parseConfigureCommand(argv: string[]): { instanceName: string; botToken: string } {
  if (argv.length === 2) {
    return { instanceName: "default", botToken: argv[1] };
  }

  if (argv.length === 4 && argv[1] === "--instance") {
    return {
      instanceName: normalizeInstanceName(argv[2]),
      botToken: argv[3],
    };
  }

  throw new Error("Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>");
}

function parseChatId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid chat id: ${value}`);
  }

  return parsed;
}

function resolveAuditStateDir(
  env: Pick<EnvSource, "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  return resolveInstanceStateDir({
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
}

function formatAccessStatus(instanceName: string, status: Awaited<ReturnType<AccessStore["getStatus"]>>): string {
  const allowlist = status.allowlist.length > 0 ? status.allowlist.join(", ") : "none";
  const pendingPairs =
    status.pendingPairs.length > 0
      ? status.pendingPairs
          .map((pair) => `${pair.code} chat ${pair.telegramChatId} expires ${pair.expiresAt}`)
          .join("; ")
      : "none";

  return [
    `Instance: ${instanceName}`,
    `Policy: ${status.policy}`,
    `Paired users: ${status.pairedUsers}`,
    `Allowlist: ${allowlist}`,
    `Pending pairs: ${pendingPairs}`,
  ].join("\n");
}

async function runAccessCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram access <pair|policy|allow|revoke> ...");
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2));
  const auditStateDir = resolveAuditStateDir(env, instanceName);
  const store = new AccessStore(resolveInstanceAccessStatePath(env, instanceName));

  if (subcommand === "pair") {
    if (args.length !== 1) {
      throw new Error("Usage: telegram access pair [--instance <name>] <code>");
    }

    const code = args[0];
    const pairedUser = await store.redeemPairingCode(code, new Date());

    if (!pairedUser) {
    await appendAuditEvent(auditStateDir, {
      type: "access.pair",
      instanceName,
      outcome: "rejected",
        metadata: { code },
      });
      throw new Error(`Pairing code "${code}" is invalid or expired.`);
    }

    await appendAuditEvent(auditStateDir, {
      type: "access.pair",
      instanceName,
      chatId: pairedUser.telegramChatId,
      userId: pairedUser.telegramUserId,
      outcome: "success",
      metadata: { code },
    });
    logger.log(`Redeemed pairing code for instance "${instanceName}" and chat ${pairedUser.telegramChatId}.`);
    return true;
  }

  if (subcommand === "policy") {
    if (args.length !== 1 || (args[0] !== "pairing" && args[0] !== "allowlist")) {
      throw new Error("Usage: telegram access policy [--instance <name>] <pairing|allowlist>");
    }

    await store.setPolicy(args[0]);
    await appendAuditEvent(auditStateDir, {
      type: "access.policy",
      instanceName,
      outcome: "success",
      metadata: { policy: args[0] },
    });
    logger.log(`Updated access policy for instance "${instanceName}" to "${args[0]}".`);
    return true;
  }

  if (subcommand === "allow") {
    if (args.length !== 1) {
      throw new Error("Usage: telegram access allow [--instance <name>] <chat-id>");
    }

    const chatId = parseChatId(args[0]);
    await store.allowChat(chatId);
    await appendAuditEvent(auditStateDir, {
      type: "access.allow",
      instanceName,
      chatId,
      outcome: "success",
    });
    logger.log(`Allowed chat ${chatId} for instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "revoke") {
    if (args.length !== 1) {
      throw new Error("Usage: telegram access revoke [--instance <name>] <chat-id>");
    }

    const chatId = parseChatId(args[0]);
    await store.revokeChat(chatId);
    await appendAuditEvent(auditStateDir, {
      type: "access.revoke",
      instanceName,
      chatId,
      outcome: "success",
    });
    logger.log(`Revoked chat ${chatId} for instance "${instanceName}".`);
    return true;
  }

  throw new Error("Usage: telegram access <pair|policy|allow|revoke> ...");
}

async function runStatusCommand(argv: string[], env: InstanceTokenEnv, logger: CliLogger): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));

  if (args.length !== 0) {
    throw new Error("Usage: telegram status [--instance <name>]");
  }

  const store = new AccessStore(resolveInstanceAccessStatePath(env, instanceName));
  const status = await store.getStatus();

  logger.log(formatAccessStatus(instanceName, status));
  return true;
}

function formatServiceStatus(status: Awaited<ReturnType<typeof getServiceStatus>>): string {
  const lines = [
    `Instance: ${status.instanceName}`,
    `Running: ${status.running ? "yes" : "no"}`,
    `Pid: ${status.pid ?? "none"}`,
    `Policy: ${status.policy}`,
    `Paired users: ${status.pairedUsers}`,
    `Allowlist count: ${status.allowlistCount}`,
    `Pending pair count: ${status.pendingPairs}`,
    `Last handled update: ${status.lastHandledUpdateId ?? "none"}`,
    `State dir: ${status.stateDir}`,
    `Stdout log: ${status.stdoutPath}`,
    `Stderr log: ${status.stderrPath}`,
    `Lock path: ${status.lockPath}`,
    `Bot token configured: ${status.botTokenConfigured ? "yes" : "no"}`,
  ];

  if (status.botTokenConfigured) {
    lines.push(
      status.botIdentityWarning ??
        `Bot identity: ${status.botIdentity?.firstName ?? "unavailable"}${
          status.botIdentity?.username ? ` (@${status.botIdentity.username})` : ""
        }`,
    );
  }

  if (status.lastErrorLine) {
    lines.push(`Last error: ${status.lastErrorLine}`);
  }

  return lines.join("\n");
}

async function runServiceCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  serviceDeps: ServiceCommandDeps,
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram service <start|stop|restart|status|logs> ...");
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2));

  if (args.length !== 0) {
    throw new Error("Usage: telegram service <start|stop|status> [--instance <name>]");
  }

  if (subcommand === "start") {
    logger.log(await startServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "stop") {
    logger.log(await stopServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "restart") {
    await stopServiceInstance(env, instanceName, serviceDeps);
    logger.log(await startServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "status") {
    logger.log(formatServiceStatus(await getServiceStatus(env, instanceName, serviceDeps)));
    return true;
  }

  if (subcommand === "logs") {
    logger.log(await getServiceLogs(env, instanceName, serviceDeps));
    return true;
  }

  throw new Error("Usage: telegram service <start|stop|restart|status|logs> ...");
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<boolean> {
  const normalized = normalizeCommandArgs(argv);
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;

  if (normalized[0] === "configure") {
    const { instanceName, botToken } = parseConfigureCommand(normalized);
    const persisted = await writeInstanceBotToken(env, instanceName, botToken);

    logger.log(`Configured Telegram bot token for instance "${persisted.instanceName}".`);
    return true;
  }

  if (normalized[0] === "access") {
    return runAccessCommand(normalized, env, logger);
  }

  if (normalized[0] === "status") {
    return runStatusCommand(normalized, env, logger);
  }

  if (normalized[0] === "service") {
    return runServiceCommand(normalized, env, logger, options.serviceDeps ?? {});
  }

  return false;
}
