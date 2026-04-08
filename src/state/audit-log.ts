import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  type: string;
  instanceName?: string;
  chatId?: number;
  userId?: number;
  updateId?: number;
  outcome?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export function resolveAuditLogPath(stateDir: string): string {
  return path.join(stateDir, "audit.log.jsonl");
}

export async function appendAuditEvent(stateDir: string, event: AuditEvent): Promise<void> {
  const filePath = resolveAuditLogPath(stateDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(
    filePath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
}
