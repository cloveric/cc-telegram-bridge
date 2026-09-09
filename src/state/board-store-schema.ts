import { z } from "zod";

export const BoardTaskStatusSchema = z.enum([
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "archived",
]);
export const BoardTaskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const BoardTaskActorSchema = z.object({
  chatId: z.number(),
  userId: z.number(),
  messageThreadId: z.number().optional(),
  conversationKey: z.string().min(1),
}).passthrough();

export const BoardTaskRunSchema = z.object({
  id: z.string().min(1),
  // `done` is retained as a read-compatible alias for pre-SQLite records.
  status: z.enum(["running", "review_requested", "succeeded", "done", "failed", "blocked", "cancelled", "timed_out"]),
  startedAt: z.string(),
  lastHeartbeatAt: z.string().optional(),
  heartbeatNote: z.string().optional(),
  completedAt: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  logText: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  attempt: z.number().int().positive().optional(),
  engine: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  dispatchTarget: z.string().min(1).optional(),
}).passthrough();

export const BoardChecklistItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
}).passthrough();

export const BoardArtifactSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
  createdAt: z.string().optional(),
}).passthrough();

export const BoardReviewGateSchema = z.object({
  required: z.boolean(),
  reviewer: z.string().optional(),
}).passthrough();

export const BoardTaskWorkspaceSchema = z.object({
  mode: z.enum(["default", "dir", "worktree", "scratch"]),
  path: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
}).passthrough();

export const BoardTaskExecutionSchema = z.object({
  engine: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
}).passthrough();

export const BoardTaskRecordSchema = z.object({
  id: z.string().min(1),
  boardSlug: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  title: z.string().min(1),
  status: BoardTaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  priority: BoardTaskPrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  checklist: z.array(BoardChecklistItemSchema).optional(),
  artifacts: z.array(BoardArtifactSchema).optional(),
  review: BoardReviewGateSchema.optional(),
  summary: z.string().optional(),
  blockedReason: z.string().optional(),
  assignee: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  runs: z.array(BoardTaskRunSchema).optional(),
  workspace: BoardTaskWorkspaceSchema.optional(),
  scheduledAt: z.string().optional(),
  timezone: z.string().min(1).optional(),
  execution: BoardTaskExecutionSchema.optional(),
  revision: z.number().int().positive().optional(),
  archivedFromStatus: BoardTaskStatusSchema.optional(),
  retryCount: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().optional(),
  createdBy: BoardTaskActorSchema,
}).passthrough();

export const BoardStoreStateSchema = z.object({
  nextTaskId: z.number().optional(),
  nextRunId: z.number().optional(),
  limits: z.object({
    global: z.number().optional(),
    perAssignee: z.number().optional(),
    perConversation: z.number().optional(),
  }).passthrough().optional(),
  tasks: z.array(BoardTaskRecordSchema).optional(),
}).passthrough();

export type BoardTaskStatus = z.infer<typeof BoardTaskStatusSchema>;
export type BoardTaskPriority = z.infer<typeof BoardTaskPrioritySchema>;
export type BoardTaskActor = z.infer<typeof BoardTaskActorSchema>;
export type BoardTaskRun = z.infer<typeof BoardTaskRunSchema>;
export type BoardChecklistItem = z.infer<typeof BoardChecklistItemSchema>;
export type BoardArtifact = z.infer<typeof BoardArtifactSchema>;
export type BoardReviewGate = z.infer<typeof BoardReviewGateSchema>;
export type BoardTaskWorkspace = z.infer<typeof BoardTaskWorkspaceSchema>;
export type BoardTaskExecution = z.infer<typeof BoardTaskExecutionSchema>;
export type BoardWipLimits = {
  global: number;
  perAssignee: number;
  perConversation: number;
};
export type BoardTaskRecord = {
  id: string;
  boardSlug: string;
  parentTaskId?: string;
  title: string;
  status: BoardTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  description?: string;
  acceptanceCriteria: string[];
  priority: BoardTaskPriority;
  labels: string[];
  checklist: BoardChecklistItem[];
  artifacts: BoardArtifact[];
  review: BoardReviewGate;
  summary?: string;
  blockedReason?: string;
  assignee?: string;
  dependencies: string[];
  runs: BoardTaskRun[];
  workspace?: BoardTaskWorkspace;
  scheduledAt?: string;
  timezone?: string;
  execution: BoardTaskExecution;
  revision: number;
  archivedFromStatus?: BoardTaskStatus;
  retryCount: number;
  nextRetryAt?: string;
  createdBy: BoardTaskActor;
};

export type BoardDispatcherPolicy = "manual" | "automatic";

export type BoardSettings = {
  limits: BoardWipLimits;
  leaseDurationMs: number;
  defaultTimeoutMs: number;
  defaultMaxRetries: number;
  retryBaseDelayMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  consecutiveInfrastructureFailures: number;
  circuitOpenUntil?: string;
  automaticReview: boolean;
};

export type BoardRecord = {
  id: number;
  slug: string;
  name: string;
  settings: BoardSettings;
  dispatcherPolicy: BoardDispatcherPolicy;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type BoardComment = {
  id: string;
  taskId: string;
  body: string;
  actor: BoardTaskActor;
  createdAt: string;
};

export type BoardAttachment = {
  id: string;
  taskId: string;
  contentHash: string;
  storagePath: string;
  originalName: string;
  mediaType?: string;
  sizeBytes: number;
  createdAt: string;
  actor: BoardTaskActor;
};

export type BoardClaim = {
  taskId: string;
  owner: string;
  leaseToken: string;
  expiresAt: string;
  heartbeatAt: string;
  createdAt: string;
};

export type BoardEvent = {
  sequence: number;
  boardSlug: string;
  taskId?: string;
  runId?: string;
  eventType: string;
  actor?: BoardTaskActor;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt: string;
};

export type BoardSubscription = {
  id: string;
  boardSlug: string;
  conversationKey: string;
  eventFilter: string[];
  createdAt: string;
};
export type BoardStoreState = {
  nextTaskId: number;
  nextRunId: number;
  limits: BoardWipLimits;
  tasks: BoardTaskRecord[];
};
