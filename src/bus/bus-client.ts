import { isPeerAllowed, loadBusConfig } from "./bus-config.js";
import { lookupInstance, resolveChannelRoot } from "./bus-registry.js";
import type { BusTalkResponse } from "./bus-server.js";

export interface BusDelegateInput {
  fromInstance: string;
  targetInstance: string;
  prompt: string;
  depth: number;
  stateDir: string;
}

export async function delegateToInstance(input: BusDelegateInput): Promise<BusTalkResponse> {
  const busConfig = await loadBusConfig(input.stateDir);
  if (!busConfig) {
    throw new Error("Bus is not enabled on this instance");
  }

  if (!isPeerAllowed(busConfig, input.targetInstance)) {
    throw new Error(`Instance "${input.targetInstance}" is not in the peer list`);
  }

  if (input.depth > busConfig.maxDepth) {
    throw new Error(`Max delegation depth (${busConfig.maxDepth}) exceeded`);
  }

  const channelRoot = resolveChannelRoot(input.stateDir);
  const target = await lookupInstance(channelRoot, input.targetInstance);
  if (!target) {
    throw new Error(
      `Instance "${input.targetInstance}" is not running or not registered on the bus`,
    );
  }

  try {
    process.kill(target.pid, 0);
  } catch {
    throw new Error(
      `Instance "${input.targetInstance}" has a stale registry entry (PID ${target.pid} is not running)`,
    );
  }

  const body = JSON.stringify({
    fromInstance: input.fromInstance,
    prompt: input.prompt,
    depth: input.depth + 1,
  });

  const url = `http://127.0.0.1:${target.port}/api/talk`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    const result = (await res.json()) as BusTalkResponse;

    if (!result.success) {
      throw new Error(result.error ?? `Delegation to "${input.targetInstance}" failed`);
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Delegation to "${input.targetInstance}" timed out after 5 minutes`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
