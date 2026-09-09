import { access, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sqlite3 from "sqlite3";
import { describe, expect, it } from "vitest";

import {
  BoardAuthorizationError,
  BoardClaimConflictError,
  BoardDependencyConflictError,
  BoardInvalidTransitionError,
  BoardService,
  BoardStaleRevisionError,
  BoardValidationError,
} from "../src/state/board-service.js";
import { parseAuditEvents, resolveAuditLogPath } from "../src/state/audit-log.js";
import { resolveKanbanDatabasePath } from "../src/state/sqlite-kanban-repository.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const actor = {
  chatId: 101,
  userId: 202,
  conversationKey: "chat:101",
};

function at(offsetMs: number): Date {
  return new Date(Date.UTC(2026, 8, 9, 8, 0, 0, offsetMs));
}

async function mutateSqlite(databasePath: string, sql: string): Promise<void> {
  const database = await new Promise<sqlite3.Database>((resolve, reject) => {
    const opened = new sqlite3.Database(databasePath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) reject(error);
      else resolve(opened);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      database.run(sql, (error) => error ? reject(error) : resolve());
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      database.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe("BoardService Phase 2 lifecycle and evidence", () => {
  it("isolates boards by conversation and enforces revisions, idempotency, settings, and subscriptions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      await expect(service.listBoards()).resolves.toEqual([
        expect.objectContaining({ slug: "main", dispatcherPolicy: "manual", revision: 1 }),
      ]);

      const created = await service.createBoard(
        { name: "Launch Board", slug: "launch" },
        { actor, idempotencyKey: "create-launch", now: at(0) },
      );
      const replayed = await service.createBoard(
        { name: "Launch Board", slug: "launch" },
        { actor, idempotencyKey: "create-launch", now: at(1) },
      );
      expect(replayed.id).toBe(created.id);
      await expect(service.getActiveBoard("chat:a")).resolves.toMatchObject({ slug: "main" });
      await service.selectBoard("chat:a", "launch", { actor, idempotencyKey: "select-launch", now: at(2) });
      await service.selectBoard("chat:a", "launch", { actor, idempotencyKey: "select-launch", now: at(3) });
      await expect(service.getActiveBoard("chat:a")).resolves.toMatchObject({ slug: "launch" });
      await expect(service.getActiveBoard("chat:b")).resolves.toMatchObject({ slug: "main" });

      const updated = await service.updateBoardSettings(
        "launch",
        { limits: { global: 4 }, defaultMaxRetries: 3 },
        { expectedRevision: created.revision, actor, now: at(4) },
      );
      expect(updated).toMatchObject({ revision: 2, settings: { limits: { global: 4 }, defaultMaxRetries: 3 } });
      await expect(service.updateBoardSettings(
        "launch",
        { retryBaseDelayMs: 100 },
        { expectedRevision: 1 },
      )).rejects.toBeInstanceOf(BoardStaleRevisionError);
      await expect(service.updateBoardSettings("launch", { limits: { global: 0 } })).rejects.toBeInstanceOf(
        BoardValidationError,
      );

      const subscription = await service.subscribe(
        "launch",
        "chat:a",
        ["task.created", "task.created", "task.done"],
        { actor, idempotencyKey: "subscribe-launch", now: at(5) },
      );
      const replayedSubscription = await service.subscribe(
        "launch",
        "chat:a",
        ["ignored-on-replay"],
        { actor, idempotencyKey: "subscribe-launch", now: at(6) },
      );
      expect(replayedSubscription).toEqual(subscription);
      expect(subscription.eventFilter).toEqual(["task.created", "task.done"]);
      await expect(service.listSubscriptions("launch")).resolves.toEqual([subscription]);

      const events = await service.listEvents({ boardSlug: "launch" });
      expect(events.map((event) => event.sequence)).toEqual(
        [...events.map((event) => event.sequence)].sort((left, right) => left - right),
      );
      expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
        "board.created",
        "board.selected",
        "board.settings_updated",
        "board.subscription_updated",
      ]));
      const auditEvents = parseAuditEvents(await readFile(resolveAuditLogPath(root), "utf8"));
      expect(auditEvents).toContainEqual(expect.objectContaining({
        type: "board.event",
        metadata: expect.objectContaining({ boardSlug: "launch", eventType: "board.created" }),
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not roll back committed board state when audit projection fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    const warning = console.warn;
    try {
      const service = new BoardService(root);
      await service.listBoards();
      await mkdir(resolveAuditLogPath(root));
      console.warn = () => undefined;
      const task = await service.createTask({ title: "Committed task", createdBy: actor });
      await expect(service.getTask(task.id)).resolves.toMatchObject({ title: "Committed task" });
      await expect(service.listEvents({ taskId: task.id })).resolves.toEqual([
        expect.objectContaining({ eventType: "task.created" }),
      ]);
    } finally {
      console.warn = warning;
      await removeTempRoot(root);
    }
  });

  it("supports triage, editing, schedules, parent links, dependencies, model overrides, archive, and delete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      await service.createBoard({ name: "Product", slug: "product" });
      const parent = await service.createTask({ title: "Epic", boardSlug: "product", createdBy: actor });
      const child = await service.createTask({
        title: "Inbox idea",
        boardSlug: "product",
        status: "triage",
        createdBy: actor,
      });
      const accepted = await service.acceptTriage(child.id, { expectedRevision: child.revision, actor });
      const edited = await service.editTask(
        child.id,
        { title: "Ship idea", description: "Detailed spec", labels: ["launch", "launch"], priority: "high" },
        { expectedRevision: accepted.revision, actor, idempotencyKey: "edit-child" },
      );
      const editReplay = await service.editTask(
        child.id,
        { title: "This value must not be applied" },
        { expectedRevision: accepted.revision, actor, idempotencyKey: "edit-child" },
      );
      expect(editReplay).toMatchObject({ title: "Ship idea", revision: edited.revision, labels: ["launch"] });

      const withParent = await service.setParentTask(child.id, parent.id, { expectedRevision: edited.revision });
      await expect(service.listChildTasks(parent.id)).resolves.toEqual([
        expect.objectContaining({ id: child.id, parentTaskId: parent.id }),
      ]);
      const configured = await service.setTaskExecution(
        child.id,
        { engine: "codex", model: "gpt-5", effort: "high", timeoutMs: 1_000, maxRetries: 4 },
        { expectedRevision: withParent.revision },
      );
      expect(configured.execution).toEqual({
        engine: "codex",
        model: "gpt-5",
        effort: "high",
        timeoutMs: 1_000,
        maxRetries: 4,
      });

      const scheduled = await service.scheduleTask(child.id, at(10_000).toISOString(), "Asia/Shanghai", {
        expectedRevision: configured.revision,
      });
      await expect(service.promoteScheduledTask(child.id, { now: at(9_999) })).rejects.toBeInstanceOf(
        BoardInvalidTransitionError,
      );
      await expect(service.promoteScheduledTask(child.id, {
        expectedRevision: scheduled.revision,
        now: at(10_000),
      })).resolves.toMatchObject({ status: "ready" });

      const dependency = await service.createTask({ title: "Dependency", boardSlug: "product", createdBy: actor });
      const linked = await service.linkDependency(child.id, dependency.id);
      expect(linked).toMatchObject({ status: "todo", dependencies: [dependency.id] });
      await expect(service.linkDependency(dependency.id, child.id)).rejects.toBeInstanceOf(BoardDependencyConflictError);
      const foreign = await service.createTask({ title: "Foreign", createdBy: actor });
      await expect(service.linkDependency(child.id, foreign.id)).rejects.toBeInstanceOf(BoardDependencyConflictError);

      const archived = await service.archiveTask(child.id, { expectedRevision: linked.revision });
      await expect(service.restoreTask(child.id, { expectedRevision: archived.revision })).resolves.toMatchObject({ status: "todo" });
      await expect(service.deleteTask(parent.id, { confirmTaskId: child.id })).rejects.toBeInstanceOf(BoardValidationError);
      const deleted = await service.deleteTask(parent.id, {
        confirmTaskId: parent.id,
        expectedRevision: parent.revision,
        idempotencyKey: "delete-parent",
      });
      expect(deleted).toEqual({ taskId: parent.id, boardSlug: "product", deleted: true });
      await expect(service.getTask(parent.id)).resolves.toBeNull();
      expect(await service.getTask(child.id)).not.toHaveProperty("parentTaskId");
      await expect(service.deleteTask(parent.id, {
        confirmTaskId: parent.id,
        idempotencyKey: "delete-parent",
      })).resolves.toEqual(deleted);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("preserves comments, claims, attachments, and their ordering across legacy task writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-outside-"));
    try {
      const service = new BoardService(root);
      const task = await service.createTask({ title: "Evidence", createdBy: actor });
      await service.setTaskWorkspace(task.id, { mode: "dir", path: root });
      await service.assignTask(task.id, "worker-private");
      await service.markReady(task.id);
      const first = await service.addComment(task.id, { body: "first", actor, now: at(1) });
      const second = await service.addComment(task.id, { body: "second", actor, now: at(2) });
      const claim = await service.claimTask(task.id, "worker-a", { now: at(3), leaseDurationMs: 10_000 });

      await service.updateTaskCard(task.id, { description: "legacy writer" });
      await expect(service.listComments(task.id)).resolves.toEqual([first.comment, second.comment]);
      await expect(service.getClaim(task.id)).resolves.toEqual(claim.claim);

      const sourcePath = path.join(root, "evidence.txt");
      await writeFile(sourcePath, "verified evidence", "utf8");
      const beforeAttach = (await service.getTask(task.id))!;
      const attached = await service.attachFile(task.id, {
        sourcePath,
        originalName: "../unsafe:name.txt",
        mediaType: "text/plain",
        actor,
        expectedRevision: beforeAttach.revision,
        idempotencyKey: "attach-evidence",
      });
      const attachReplay = await service.attachFile(task.id, {
        sourcePath,
        actor,
        expectedRevision: beforeAttach.revision,
        idempotencyKey: "attach-evidence",
      });
      expect(attachReplay.attachment.id).toBe(attached.attachment.id);
      expect(attached.attachment.originalName).toBe("unsafe_name.txt");
      await expect(service.listAttachments(task.id)).resolves.toEqual([attached.attachment]);

      const outsidePath = path.join(outsideRoot, "outside.txt");
      await writeFile(outsidePath, "outside", "utf8");
      await expect(service.attachFile(task.id, { sourcePath: outsidePath, actor })).rejects.toBeInstanceOf(
        BoardAuthorizationError,
      );

      const exported = await service.exportBoard("main", {
        includeAttachmentData: true,
        includeEvents: true,
      });
      expect(exported.tasks[0]!.createdBy).toMatchObject({ conversationKey: "redacted" });
      expect(exported.tasks[0]!.assignee).toBeUndefined();
      expect(exported.tasks[0]!.workspace).toEqual({ mode: "dir" });
      expect(JSON.stringify(exported)).not.toContain(root);
      expect(JSON.stringify(exported)).not.toContain("worker-private");
      expect(exported.events?.every((event) => event.actor === undefined)).toBe(true);
      expect(JSON.stringify(exported.events)).not.toMatch(/"(?:chatId|userId|conversationKey)"/);
      expect(exported.attachments[0]!.dataBase64).toBe(Buffer.from("verified evidence").toString("base64"));

      const collisionRoot = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-import-collision-"));
      try {
        const collisionService = new BoardService(collisionRoot);
        await expect(collisionService.importBoard(exported, { slug: "main" })).rejects.toThrow("already exists");
        await expect(readdir(path.join(collisionRoot, "kanban-assets"))).resolves.toEqual([]);
      } finally {
        await removeTempRoot(collisionRoot);
      }

      const importRoot = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-import-"));
      try {
        const importedService = new BoardService(importRoot);
        await importedService.importBoard(exported, { slug: "imported", name: "Imported" });
        await expect(importedService.listBoardTasks("imported")).resolves.toHaveLength(1);
        await expect(importedService.listComments(task.id)).resolves.toHaveLength(2);
        const importedAttachment = (await importedService.listAttachments(task.id))[0]!;
        expect(await readFile(path.join(importRoot, "kanban-assets", importedAttachment.storagePath), "utf8")).toBe(
          "verified evidence",
        );
      } finally {
        await removeTempRoot(importRoot);
      }

      const current = (await service.getTask(task.id))!;
      const detached = await service.detachAttachment(task.id, attached.attachment.id, {
        expectedRevision: current.revision,
        idempotencyKey: "detach-evidence",
      });
      const detachReplay = await service.detachAttachment(task.id, attached.attachment.id, {
        expectedRevision: current.revision,
        idempotencyKey: "detach-evidence",
      });
      expect(detachReplay.attachment).toEqual(detached.attachment);
      const preview = await service.gcAssets();
      expect(preview.candidates).toContain(attached.attachment.storagePath);
      const gc = await service.gcAssets({ confirm: true, now: at(20) });
      expect(gc.quarantined).toEqual([attached.attachment.storagePath]);
      await expect(access(path.join(gc.quarantineDir!, attached.attachment.storagePath))).resolves.toBeUndefined();
    } finally {
      await removeTempRoot(outsideRoot);
      await removeTempRoot(root);
    }
  });

  it("implements claims, evidence, review, and approval-only dependency promotion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      const implementation = await service.createTask({
        title: "Implementation",
        createdBy: actor,
        review: { required: true, reviewer: "reviewer-a" },
      });
      const followUp = await service.createTask({ title: "Follow-up", createdBy: actor });
      await service.linkDependency(followUp.id, implementation.id);
      const ready = await service.markReady(implementation.id);
      const claimed = await service.claimTask(implementation.id, "worker-a", {
        expectedRevision: ready.task.revision,
        leaseDurationMs: 2_000,
        idempotencyKey: "claim-implementation",
        now: at(0),
      });
      await expect(service.claimTask(implementation.id, "worker-b", { now: at(1) })).rejects.toBeInstanceOf(
        BoardClaimConflictError,
      );
      const heartbeat = await service.heartbeatClaim(implementation.id, claimed.claim.leaseToken, {
        expectedRevision: claimed.task.revision,
        leaseDurationMs: 2_000,
        note: "working",
        idempotencyKey: "heartbeat-implementation",
        now: at(500),
      });
      const heartbeatReplay = await service.heartbeatClaim(implementation.id, claimed.claim.leaseToken, {
        expectedRevision: claimed.task.revision,
        idempotencyKey: "heartbeat-implementation",
        now: at(600),
      });
      expect(heartbeatReplay.claim.expiresAt).toBe(heartbeat.claim.expiresAt);

      const started = await service.startClaimedTask(implementation.id, claimed.claim.leaseToken, {
        expectedRevision: heartbeat.task.revision,
        now: at(700),
      });
      const runId = started.task.runs.at(-1)!.id;
      const evidenced = await service.updateRunEvidence(
        implementation.id,
        runId,
        { logText: "tests passed", inputTokens: 12, outputTokens: 34, costUsd: 0.25 },
        { expectedRevision: started.task.revision },
      );
      const completed = await service.completeClaimedTask(
        implementation.id,
        claimed.claim.leaseToken,
        "ready for review",
        { expectedRevision: evidenced.revision, now: at(800) },
      );
      expect(completed.promotedTaskIds).toEqual([]);
      expect(completed.task).toMatchObject({
        status: "review",
        runs: [expect.objectContaining({
          id: runId,
          status: "review_requested",
          logText: "tests passed",
          inputTokens: 12,
          outputTokens: 34,
          costUsd: 0.25,
        })],
      });
      await expect(service.getClaim(implementation.id)).resolves.toBeNull();
      await expect(service.getTask(followUp.id)).resolves.toMatchObject({ status: "todo" });

      const changes = await service.requestChanges(implementation.id, "add a regression test", {
        expectedRevision: completed.task.revision,
      });
      const reopened = await service.reopenReview(implementation.id, { expectedRevision: changes.revision });
      const approved = await service.approveReview(implementation.id, { expectedRevision: reopened.revision, now: at(900) });
      expect(approved.promotedTaskIds).toEqual([followUp.id]);
      await expect(service.getTask(followUp.id)).resolves.toMatchObject({ status: "ready" });
      await expect(service.stats("main")).resolves.toMatchObject({
        completedRuns: 1,
        totalInputTokens: 12,
        totalOutputTokens: 34,
        totalCostUsd: 0.25,
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("redacts credential patterns before task, comment, run, event, and export persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      const secrets = [
        "sk-live-task-123",
        "bearer-comment-456",
        "token-heartbeat-789",
        "secret-summary-012",
        "bearer-cancel-345",
        "actor-token-678",
      ];
      const task = await service.createTask({
        title: `Inspect api_key=${secrets[0]}`,
        description: `Never retain client_secret=${secrets[3]}`,
        createdBy: { ...actor, metadata: `api_key=${secrets[5]}` },
      });
      await service.addComment(task.id, {
        body: `Authorization: Bearer ${secrets[1]}`,
        actor,
      });
      const ready = await service.markReady(task.id);
      const claimed = await service.claimTask(task.id, "worker-a", {
        expectedRevision: ready.task.revision,
        leaseDurationMs: 10_000,
        now: at(0),
      });
      const started = await service.startClaimedTask(task.id, claimed.claim.leaseToken, {
        expectedRevision: claimed.task.revision,
        now: at(1),
      });
      const heartbeat = await service.heartbeatClaim(task.id, claimed.claim.leaseToken, {
        expectedRevision: started.task.revision,
        note: `token=${secrets[2]}`,
        now: at(2),
      });
      const evidenced = await service.updateRunEvidence(
        task.id,
        heartbeat.task.runs.at(-1)!.id,
        {
          logText: `Authorization: Bearer ${secrets[1]}`,
          summary: `client_secret=${secrets[3]}`,
        },
        { expectedRevision: heartbeat.task.revision, now: at(3) },
      );
      const cancelled = await service.cancelTask(task.id, `Bearer ${secrets[4]}`, {
        expectedRevision: evidenced.revision,
        now: at(4),
      });
      const cancelledRunId = cancelled.runs.at(-1)!.id;

      const persisted = {
        task: await service.getTask(task.id),
        comments: await service.listComments(task.id),
        events: await service.listEvents({ taskId: task.id }),
        exported: await service.exportBoard("main", {
          includeDetailedLogs: true,
          includeActorIdentifiers: true,
          includeEvents: true,
        }),
        audit: await readFile(resolveAuditLogPath(root), "utf8"),
      };
      const serialized = JSON.stringify(persisted);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain("[redacted]");
      expect(persisted.events).toContainEqual(expect.objectContaining({
        eventType: "task.cancelled",
        runId: cancelledRunId,
      }));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("routes legacy mutation aliases through revisions, idempotency, and the authoritative event stream", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      const task = await service.createTask({ title: "Compatibility", createdBy: actor });
      const edited = await service.updateTaskCard(
        task.id,
        { description: "eventful" },
        { actor, expectedRevision: task.revision, idempotencyKey: "legacy-edit", now: at(1) },
      );
      const replay = await service.updateTaskCard(
        task.id,
        { description: "must not overwrite" },
        { actor, expectedRevision: task.revision, idempotencyKey: "legacy-edit", now: at(2) },
      );
      expect(replay).toMatchObject({ description: "eventful", revision: edited.revision });
      const assigned = await service.assignTask(task.id, "worker-a", {
        expectedRevision: edited.revision,
        now: at(3),
      });
      const ready = await service.markReady(task.id, {
        expectedRevision: assigned.revision,
        idempotencyKey: "legacy-ready",
        now: at(4),
      });
      const running = await service.startReadyTask(task.id, {
        expectedRevision: ready.task.revision,
        idempotencyKey: "legacy-start",
        now: at(5),
      });
      await service.blockTask(task.id, "manual pause", {
        expectedRevision: running.revision,
        idempotencyKey: "legacy-block",
        now: at(6),
      });

      const eventTypes = (await service.listEvents({ taskId: task.id })).map((event) => event.eventType);
      expect(eventTypes).toEqual(expect.arrayContaining([
        "task.created",
        "task.edited",
        "task.reassigned",
        "task.marked_ready",
        "task.run_started",
        "task.blocked",
      ]));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("serializes cross-service claims and compare-and-swap edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const firstService = new BoardService(root);
      const secondService = new BoardService(root);
      const created = await firstService.createTask({ title: "Concurrent task", createdBy: actor });
      const ready = await firstService.markReady(created.id);

      const claims = await Promise.allSettled([
        firstService.claimTask(created.id, "worker-a", {
          expectedRevision: ready.task.revision,
          leaseDurationMs: 5_000,
          now: at(0),
        }),
        secondService.claimTask(created.id, "worker-b", {
          expectedRevision: ready.task.revision,
          leaseDurationMs: 5_000,
          now: at(0),
        }),
      ]);
      expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejectedClaim = claims.find((result) => result.status === "rejected");
      expect((rejectedClaim as PromiseRejectedResult).reason).toBeInstanceOf(BoardStaleRevisionError);

      const current = (await firstService.getTask(created.id))!;
      const edits = await Promise.allSettled([
        firstService.editTask(created.id, { description: "first" }, { expectedRevision: current.revision }),
        secondService.editTask(created.id, { description: "second" }, { expectedRevision: current.revision }),
      ]);
      expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejectedEdit = edits.find((result) => result.status === "rejected");
      expect((rejectedEdit as PromiseRejectedResult).reason).toBeInstanceOf(BoardStaleRevisionError);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("releases expired idle claims and times out active runs deterministically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      const idle = await service.createTask({ title: "Idle claim", createdBy: actor });
      const idleReady = await service.markReady(idle.id);
      await service.claimTask(idle.id, "worker-a", {
        expectedRevision: idleReady.task.revision,
        leaseDurationMs: 1_000,
        now: at(0),
      });
      await expect(service.recoverExpiredClaims(at(999))).resolves.toEqual([]);
      await expect(service.recoverExpiredClaims(at(1_000))).resolves.toEqual([
        expect.objectContaining({ id: idle.id, status: "ready" }),
      ]);
      await expect(service.getClaim(idle.id)).resolves.toBeNull();

      const takeover = await service.createTask({ title: "Claim takeover", createdBy: actor });
      const takeoverReady = await service.markReady(takeover.id);
      const firstClaim = await service.claimTask(takeover.id, "worker-old", {
        expectedRevision: takeoverReady.task.revision,
        leaseDurationMs: 1_000,
        idempotencyKey: "claim-old",
        now: at(0),
      });
      const replacement = await service.claimTask(takeover.id, "worker-new", {
        expectedRevision: firstClaim.task.revision,
        leaseDurationMs: 1_000,
        now: at(1_000),
      });
      expect(replacement).toMatchObject({ task: { revision: firstClaim.task.revision + 2 }, claim: { owner: "worker-new" } });
      await expect(service.claimTask(takeover.id, "worker-old", {
        idempotencyKey: "claim-old",
        now: at(1_001),
      })).rejects.toBeInstanceOf(BoardClaimConflictError);
      await expect(service.listEvents({ taskId: takeover.id })).resolves.toContainEqual(expect.objectContaining({
        eventType: "task.claim_expired",
        payload: expect.objectContaining({ status: "ready", revision: firstClaim.task.revision + 1 }),
      }));

      const running = await service.createTask({ title: "Timed run", createdBy: { ...actor, conversationKey: "chat:other" } });
      const runningReady = await service.markReady(running.id);
      const claim = await service.claimTask(running.id, "worker-b", {
        expectedRevision: runningReady.task.revision,
        leaseDurationMs: 5_000,
        now: at(0),
      });
      const started = await service.startClaimedTask(running.id, claim.claim.leaseToken, {
        expectedRevision: claim.task.revision,
        now: at(0),
      });
      await service.setTaskExecution(running.id, { timeoutMs: 1_000 }, { expectedRevision: started.task.revision });
      await expect(service.recoverTimedOutRuns(at(999))).resolves.toEqual([]);
      await expect(service.recoverTimedOutRuns(at(1_000))).resolves.toEqual([
        expect.objectContaining({
          id: running.id,
          status: "blocked",
          runs: [expect.objectContaining({ status: "timed_out" })],
        }),
      ]);
      await expect(service.getClaim(running.id)).resolves.toBeNull();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("recovers an expired active claim during automatic dispatch before selecting new work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      await service.updateBoardSettings("main", {
        limits: { global: 2, perAssignee: 2, perConversation: 2 },
      });
      await service.setDispatcherPolicy("main", "automatic");
      const expired = await service.createTask({
        title: "Expired worker",
        createdBy: { ...actor, conversationKey: "chat:expired" },
      });
      const next = await service.createTask({
        title: "Next worker",
        createdBy: { ...actor, conversationKey: "chat:next" },
      });
      const expiredReady = await service.markReady(expired.id);
      await service.markReady(next.id);
      const claim = await service.claimTask(expired.id, "worker-expired", {
        expectedRevision: expiredReady.task.revision,
        leaseDurationMs: 1_000,
        now: at(0),
      });
      await service.startClaimedTask(expired.id, claim.claim.leaseToken, {
        expectedRevision: claim.task.revision,
        now: at(0),
      });
      await service.updateBoardSettings("main", { circuitOpenUntil: at(2_000).toISOString() });

      const paused = await service.dispatchNext("main", { owner: "worker-next", now: at(1_000) });
      expect(paused).toMatchObject({ task: null, claim: null, reason: "circuit_open" });
      await expect(service.getTask(expired.id)).resolves.toMatchObject({
        status: "blocked",
        blockedReason: "claim lease expired",
        runs: [expect.objectContaining({ status: "timed_out", error: "claim lease expired" })],
      });
      await expect(service.getClaim(expired.id)).resolves.toBeNull();
      await expect(service.listEvents({ taskId: expired.id })).resolves.toContainEqual(
        expect.objectContaining({ eventType: "task.claim_expired", runId: expect.any(String) }),
      );
      const dispatched = await service.dispatchNext("main", { owner: "worker-next", now: at(2_000) });
      expect(dispatched.task).toMatchObject({ id: next.id, status: "running" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("dispatches by priority with opt-in policy, retries, and a bounded circuit breaker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      await service.updateBoardSettings("main", {
        defaultMaxRetries: 1,
        retryBaseDelayMs: 100,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 500,
        limits: { global: 2, perAssignee: 2, perConversation: 2 },
      });
      const low = await service.createTask({ title: "Low", priority: "low", createdBy: actor });
      const high = await service.createTask({
        title: "High",
        priority: "urgent",
        createdBy: { ...actor, conversationKey: "chat:high" },
      });
      await service.markReady(low.id);
      await service.markReady(high.id);
      await expect(service.dispatchNext("main", { now: at(0) })).resolves.toMatchObject({ reason: "manual" });
      await service.setDispatcherPolicy("main", "automatic");

      const first = await service.dispatchNext("main", {
        owner: "dispatcher-a",
        idempotencyKey: "dispatch-first",
        now: at(0),
      });
      expect(first.task).toMatchObject({ id: high.id, status: "running" });
      const replay = await service.dispatchNext("main", {
        owner: "ignored",
        idempotencyKey: "dispatch-first",
        now: at(1),
      });
      expect(replay.claim?.leaseToken).toBe(first.claim?.leaseToken);

      const retry = await service.recordDispatchFailure(high.id, first.claim!.leaseToken, "provider unavailable", {
        infrastructure: true,
        expectedRevision: first.task!.revision,
        now: at(10),
      });
      expect(retry).toMatchObject({ status: "scheduled", retryCount: 1, nextRetryAt: at(110).toISOString() });
      await expect(service.dispatchNext("main", { now: at(200) })).resolves.toMatchObject({ reason: "circuit_open" });

      const second = await service.dispatchNext("main", { owner: "dispatcher-a", now: at(510) });
      expect(second.task).toMatchObject({ id: high.id, status: "running" });
      expect(second.task!.runs.at(-1)).toMatchObject({ attempt: 2 });
      const blocked = await service.recordDispatchFailure(high.id, second.claim!.leaseToken, "still unavailable", {
        expectedRevision: second.task!.revision,
        now: at(520),
      });
      expect(blocked).toMatchObject({ status: "blocked", retryCount: 2 });
      const next = await service.dispatchNext("main", { owner: "dispatcher-a", now: at(600) });
      expect(next.task).toMatchObject({ id: low.id, status: "running" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("backs up before repairing inconsistent run state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-phase2-"));
    try {
      const service = new BoardService(root);
      const task = await service.createTask({ title: "Repair me", createdBy: actor });
      await service.markReady(task.id);
      await service.startReadyTask(task.id);
      const databasePath = resolveKanbanDatabasePath(root);
      await mutateSqlite(databasePath, `UPDATE tasks SET status = 'todo' WHERE id = '${task.id}'`);

      const diagnostics = await service.operationalDiagnostics();
      expect(diagnostics.inconsistentRuns).toEqual([`${task.id}: active run while task is todo`]);
      const preview = await service.repair();
      expect(preview.changed).toBe(false);
      expect(preview).not.toHaveProperty("backupPath");
      const repaired = await service.repair({ confirm: true, now: at(0), actor });
      expect(repaired).toMatchObject({ changed: true, inconsistentRuns: diagnostics.inconsistentRuns });
      expect(repaired.backupPath).toBeTruthy();
      await expect(access(repaired.backupPath!)).resolves.toBeUndefined();
      expect((await lstat(repaired.backupPath!)).mode & 0o777).toBe(0o600);
      await expect(service.getTask(task.id)).resolves.toMatchObject({
        status: "todo",
        runs: [expect.objectContaining({ status: "blocked" })],
      });
      await expect(service.operationalDiagnostics()).resolves.toMatchObject({ inconsistentRuns: [] });
    } finally {
      await removeTempRoot(root);
    }
  });
});
