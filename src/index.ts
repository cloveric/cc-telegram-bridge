import { runCli } from "./commands/cli.js";
import { createServiceDependenciesForInstance, parseServiceInstanceName, pollTelegramUpdates } from "./service.js";

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);

    if (await runCli(argv)) {
      return;
    }

    const instanceName = parseServiceInstanceName(argv);
    const { api, bridge } = await createServiceDependenciesForInstance(
      {
        USERPROFILE: process.env.USERPROFILE,
        CODEX_TELEGRAM_STATE_DIR: process.env.CODEX_TELEGRAM_STATE_DIR,
        CODEX_EXECUTABLE: process.env.CODEX_EXECUTABLE,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      },
      instanceName,
    );

    await pollTelegramUpdates(api, bridge);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
