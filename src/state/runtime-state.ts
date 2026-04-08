import { JsonStore } from "./json-store.js";

export interface RuntimeState {
  lastHandledUpdateId: number | null;
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<RuntimeState>;
  return candidate.lastHandledUpdateId === null || typeof candidate.lastHandledUpdateId === "number";
}

export function createDefaultRuntimeState(): RuntimeState {
  return {
    lastHandledUpdateId: null,
  };
}

export class RuntimeStateStore {
  private readonly store: JsonStore<RuntimeState>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.store = new JsonStore<RuntimeState>(filePath, (value) => {
      if (isRuntimeState(value)) {
        return value;
      }

      throw new Error("invalid runtime state");
    });
  }

  async load(): Promise<RuntimeState> {
    return this.store.read(createDefaultRuntimeState());
  }

  async claimUpdateId(updateId: number): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const state = await this.load();
      if (state.lastHandledUpdateId !== null && updateId <= state.lastHandledUpdateId) {
        return false;
      }

      state.lastHandledUpdateId = updateId;
      await this.store.write(state);
      return true;
    });
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
