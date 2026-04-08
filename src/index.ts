import { runCli } from "./commands/cli.js";

async function main(): Promise<void> {
  try {
    if (await runCli(process.argv.slice(2))) {
      return;
    }

    console.log("codex-telegram-channel service placeholder");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
