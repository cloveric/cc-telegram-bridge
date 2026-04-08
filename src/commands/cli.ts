import type { InstanceTokenEnv } from "./access.js";
import { writeInstanceBotToken } from "./access.js";

export interface CliLogger {
  log: (message: string) => void;
  error: (message: string) => void;
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
  const instanceNameIndex = argv.indexOf("--instance");
  let instanceName = "default";
  let tokens = argv.slice(1);

  if (instanceNameIndex !== -1) {
    const next = argv[instanceNameIndex + 1];
    if (!next || next.startsWith("-")) {
      throw new Error("Missing instance name after --instance");
    }

    instanceName = next;
    tokens = argv.slice(1, instanceNameIndex).concat(argv.slice(instanceNameIndex + 2));
  }

  const botToken = tokens.find((value) => !value.startsWith("-"));
  if (!botToken) {
    throw new Error("Missing bot token for configure command");
  }

  return { instanceName, botToken };
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
