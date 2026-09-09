import {
  BoardStore,
  type BoardCompletionResult,
  type BoardPlanInput,
  type BoardReadyResult,
  type BoardTaskCardUpdate,
  type BoardTaskInput,
  type BoardTaskPriority,
  type BoardTaskRecord,
  type BoardTaskStatus,
  type BoardTaskWorkspaceInput,
  type BoardWipLimits,
} from "./board-store.js";
import type { BoardDiagnostics } from "./sqlite-kanban-repository.js";

export type BoardErrorCode =
  | "BOARD_NOT_FOUND"
  | "BOARD_INVALID_TRANSITION"
  | "BOARD_DEPENDENCY_CONFLICT"
  | "BOARD_WIP_LIMIT"
  | "BOARD_CLAIM_CONFLICT"
  | "BOARD_STALE_REVISION"
  | "BOARD_AUTHORIZATION"
  | "BOARD_VALIDATION"
  | "BOARD_STORAGE"
  | "BOARD_DISPATCH"
  | "BOARD_OPERATION_FAILED";

export class BoardDomainError extends Error {
  constructor(
    public readonly code: BoardErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoardDomainError";
  }
}

export class BoardNotFoundError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_NOT_FOUND", message, options);
    this.name = "BoardNotFoundError";
  }
}

export class BoardInvalidTransitionError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_INVALID_TRANSITION", message, options);
    this.name = "BoardInvalidTransitionError";
  }
}

export class BoardDependencyConflictError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_DEPENDENCY_CONFLICT", message, options);
    this.name = "BoardDependencyConflictError";
  }
}

export class BoardWipLimitError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_WIP_LIMIT", message, options);
    this.name = "BoardWipLimitError";
  }
}

export class BoardClaimConflictError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_CLAIM_CONFLICT", message, options);
    this.name = "BoardClaimConflictError";
  }
}

export class BoardStaleRevisionError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_STALE_REVISION", message, options);
    this.name = "BoardStaleRevisionError";
  }
}

export class BoardAuthorizationError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_AUTHORIZATION", message, options);
    this.name = "BoardAuthorizationError";
  }
}

export class BoardValidationError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_VALIDATION", message, options);
    this.name = "BoardValidationError";
  }
}

export class BoardStorageError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_STORAGE", message, options);
    this.name = "BoardStorageError";
  }
}

export class BoardDispatchError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_DISPATCH", message, options);
    this.name = "BoardDispatchError";
  }
}

function classifyBoardError(error: unknown): BoardDomainError {
  if (error instanceof BoardDomainError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const options = error instanceof Error ? { cause: error } : undefined;
  if (/board (?:task|checklist item) not found/i.test(message)) {
    return new BoardNotFoundError(message, options);
  }
  if (/WIP limit/i.test(message)) {
    return new BoardWipLimitError(message, options);
  }
  if (/dependency cycle|unmet dependencies|cannot depend on itself|unknown board plan dependency/i.test(message)) {
    return new BoardDependencyConflictError(message, options);
  }
  if (/already running|cannot be (?:started|marked ready)|must be .* before starting|has no running run|is not in review/i.test(message)) {
    return new BoardInvalidTransitionError(message, options);
  }
  if (/SQLITE_|Kanban database|repository transaction|invalid board store state|schema version/i.test(message)) {
    return new BoardStorageError(message, options);
  }
  if (/required|invalid board|must be absolute|at most \d+ tasks|duplicate board plan key/i.test(message)) {
    return new BoardValidationError(message, options);
  }
  return new BoardDomainError("BOARD_OPERATION_FAILED", message, options);
}

async function runBoardOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw classifyBoardError(error);
  }
}

/** Shared application boundary used by Telegram, Lark, CLI, Web, and model tools. */
export class BoardService {
  private readonly store: BoardStore;

  constructor(stateDir: string, store?: BoardStore) {
    this.store = store ?? new BoardStore(stateDir);
  }

  async listTasks(status?: BoardTaskStatus): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.listTasks(status));
  }

  async getTask(id: string): Promise<BoardTaskRecord | null> {
    return await runBoardOperation(() => this.store.getTask(id));
  }

  async createTask(input: BoardTaskInput): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.createTask(input));
  }

  async updateTaskCard(id: string, update: BoardTaskCardUpdate): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.updateTaskCard(id, update));
  }

  async appendAcceptanceCriterion(id: string, criterion: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.appendAcceptanceCriterion(id, criterion));
  }

  async appendChecklistItem(id: string, text: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.appendChecklistItem(id, text));
  }

  async setChecklistItemDone(id: string, checklistItemId: string, done: boolean): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setChecklistItemDone(id, checklistItemId, done));
  }

  async getLimits(): Promise<BoardWipLimits> {
    return await runBoardOperation(() => this.store.getLimits());
  }

  async setLimits(limits: Partial<BoardWipLimits>): Promise<BoardWipLimits> {
    return await runBoardOperation(() => this.store.setLimits(limits));
  }

  async createPlan(input: BoardPlanInput): Promise<{ tasks: BoardTaskRecord[] }> {
    return await runBoardOperation(() => this.store.createPlan(input));
  }

  async setTaskWorkspace(id: string, workspace: BoardTaskWorkspaceInput): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setTaskWorkspace(id, workspace));
  }

  async heartbeatTask(id: string, note?: string, now?: Date): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.heartbeatTask(id, note, now));
  }

  async recoverStaleRuns(input: { olderThanMs: number; now?: Date; reason?: string }): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.recoverStaleRuns(input));
  }

  async assignTask(id: string, assignee: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.assignTask(id, assignee));
  }

  async addDependency(id: string, dependencyId: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.addDependency(id, dependencyId));
  }

  async markReady(id: string): Promise<BoardReadyResult> {
    return await runBoardOperation(() => this.store.markReady(id));
  }

  async startTask(id: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.startTask(id));
  }

  async startReadyTask(id: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.startReadyTask(id));
  }

  async failTask(id: string, error: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.failTask(id, error));
  }

  async failRunningRun(id: string, runId: string, error: string): Promise<BoardTaskRecord | null> {
    return await runBoardOperation(() => this.store.failRunningRun(id, runId, error));
  }

  async blockTask(id: string, reason: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.blockTask(id, reason));
  }

  async unblockTask(id: string): Promise<BoardReadyResult> {
    return await runBoardOperation(() => this.store.unblockTask(id));
  }

  async completeTask(id: string, summary?: string): Promise<BoardCompletionResult> {
    return await runBoardOperation(() => this.store.completeTask(id, summary));
  }

  async completeRunningRun(id: string, runId: string, summary?: string): Promise<BoardCompletionResult | null> {
    return await runBoardOperation(() => this.store.completeRunningRun(id, runId, summary));
  }

  async setReviewGate(id: string, review: { required: boolean; reviewer?: string }): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setReviewGate(id, review));
  }

  async approveTask(id: string): Promise<BoardCompletionResult> {
    return await runBoardOperation(() => this.store.approveTask(id));
  }

  async rejectTask(id: string, reason: string): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.rejectTask(id, reason));
  }

  async diagnostics(): Promise<BoardDiagnostics> {
    return await runBoardOperation(() => this.store.diagnostics());
  }
}

export type BoardOperations = Pick<
  BoardService,
  | "listTasks"
  | "getTask"
  | "createTask"
  | "updateTaskCard"
  | "appendAcceptanceCriterion"
  | "appendChecklistItem"
  | "setChecklistItemDone"
  | "getLimits"
  | "setLimits"
  | "createPlan"
  | "setTaskWorkspace"
  | "heartbeatTask"
  | "recoverStaleRuns"
  | "assignTask"
  | "addDependency"
  | "markReady"
  | "startTask"
  | "startReadyTask"
  | "failTask"
  | "failRunningRun"
  | "blockTask"
  | "unblockTask"
  | "completeTask"
  | "completeRunningRun"
  | "setReviewGate"
  | "approveTask"
  | "rejectTask"
  | "diagnostics"
>;

export type { BoardTaskPriority };
