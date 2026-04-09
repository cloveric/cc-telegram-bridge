import path from "node:path";

import { JsonStore } from "./json-store.js";

export type FileWorkflowKind = "image" | "document" | "archive";
export type FileWorkflowStatus = "processing" | "awaiting_continue" | "completed" | "failed";

export interface FileWorkflowRecord {
  uploadId: string;
  chatId: number;
  userId: number;
  kind: FileWorkflowKind;
  status: FileWorkflowStatus;
  sourceFiles: string[];
  derivedFiles: string[];
  summary: string;
  extractedPath?: string;
  createdAt: string;
  updatedAt: string;
}

interface FileWorkflowState {
  records: FileWorkflowRecord[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFileWorkflowRecord(value: unknown): value is FileWorkflowRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Partial<FileWorkflowRecord>;
  return (
    typeof record.uploadId === "string" &&
    typeof record.chatId === "number" &&
    typeof record.userId === "number" &&
    (record.kind === "image" || record.kind === "document" || record.kind === "archive") &&
    (record.status === "processing" ||
      record.status === "awaiting_continue" ||
      record.status === "completed" ||
      record.status === "failed") &&
    isStringArray(record.sourceFiles) &&
    isStringArray(record.derivedFiles) &&
    typeof record.summary === "string" &&
    (record.extractedPath === undefined || typeof record.extractedPath === "string") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isFileWorkflowState(value: unknown): value is FileWorkflowState {
  return (
    typeof value === "object" &&
    value !== null &&
    "records" in value &&
    Array.isArray((value as FileWorkflowState).records) &&
    (value as FileWorkflowState).records.every(isFileWorkflowRecord)
  );
}

function createDefaultState(): FileWorkflowState {
  return { records: [] };
}

export function resolveFileWorkflowStatePath(stateDir: string): string {
  return path.join(stateDir, "file-workflow.json");
}

export class FileWorkflowStore {
  private readonly store: JsonStore<FileWorkflowState>;

  constructor(stateDir: string) {
    this.store = new JsonStore<FileWorkflowState>(resolveFileWorkflowStatePath(stateDir), (value) => {
      if (isFileWorkflowState(value)) {
        return value;
      }

      throw new Error("invalid file workflow state");
    });
  }

  async load(): Promise<FileWorkflowState> {
    return await this.store.read(createDefaultState());
  }

  async append(record: FileWorkflowRecord): Promise<void> {
    const state = await this.load();
    state.records.push(record);
    await this.store.write(state);
  }

  async update(uploadId: string, mutate: (record: FileWorkflowRecord) => void): Promise<FileWorkflowRecord | null> {
    const state = await this.load();
    const record = state.records.find((entry) => entry.uploadId === uploadId);
    if (!record) {
      return null;
    }

    mutate(record);
    record.updatedAt = new Date().toISOString();
    await this.store.write(state);
    return record;
  }

  async getLatestAwaitingArchive(chatId: number): Promise<FileWorkflowRecord | null> {
    const state = await this.load();
    const candidates = state.records.filter((record) => record.chatId === chatId && record.kind === "archive" && record.status === "awaiting_continue");
    return candidates.at(-1) ?? null;
  }
}
