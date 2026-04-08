import type { InstanceTokenEnv } from "./access.js";
import { writeInstanceBotToken } from "./access.js";
import { normalizeInstanceName } from "../instance.js";

export interface CliLogger {
  log: (message: string) => void;
}

export interface CliOptions {
  env?: InstanceTokenEnv;
  logger?: CliLogger;
}

function normalizeCommandArgs(argv: string[]): string[] {
  if (argv[0] === "telegram") {
    return argv.slice(1);
  }

  return argv;
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

export async function runCli(argv: string[], options: CliOptions = {}): Promise<boolean> {
  const normalized = normalizeCommandArgs(argv);
  const logger = options.logger ?? console;

  if (normalized[0] !== "configure") {
    return false;
  }

  const { instanceName, botToken } = parseConfigureCommand(normalized);
  const persisted = await writeInstanceBotToken(options.env ?? process.env, instanceName, botToken);

  logger.log(`Configured Telegram bot token for instance "${persisted.instanceName}".`);
  return true;
}
