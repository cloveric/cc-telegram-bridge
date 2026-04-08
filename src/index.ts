import { runCli } from "./commands/cli.js";
import { acquireInstanceLock } from "./state/instance-lock.js";
import { resolveConfig } from "./config.js";
import {
  createServiceDependencies,
  parseServiceInstanceName,
  pollTelegramUpdates,
  resolveServiceEnvForInstance,
} from "./service.js";

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);

    if (await runCli(argv)) {
      return;
    }

    const instanceName = parseServiceInstanceName(argv);
    const resolvedEnv = await resolveServiceEnvForInstance(
      {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        CODEX_TELEGRAM_STATE_DIR: process.env.CODEX_TELEGRAM_STATE_DIR,
        CODEX_EXECUTABLE: process.env.CODEX_EXECUTABLE,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      },
      instanceName,
    );

    const serviceConfig = resolveConfig(resolvedEnv);
    const instanceLock = await acquireInstanceLock(serviceConfig.stateDir);
    const releaseLockOnExit = () => {
      instanceLock.releaseSync();
    };

    process.once("exit", releaseLockOnExit);

    const abortController = new AbortController();
    const shutdown = () => {
      abortController.abort();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    const { api, bridge, config } = await createServiceDependencies(resolvedEnv);
    try {
      await pollTelegramUpdates(api, bridge, config.inboxDir, console, abortController.signal);
    } finally {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      process.removeListener("exit", releaseLockOnExit);
      await instanceLock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
