import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BoardDependencyConflictError,
  BoardInvalidTransitionError,
  BoardNotFoundError,
  BoardService,
  BoardValidationError,
  BoardWipLimitError,
} from "../src/state/board-service.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("BoardService", () => {
  it("exposes current board behavior through typed domain errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-board-service-"));
    try {
      const service = new BoardService(root);
      const actor = { chatId: 1, userId: 2, conversationKey: "chat:1" };

      await expect(service.createTask({ title: " ", createdBy: actor })).rejects.toBeInstanceOf(BoardValidationError);
      await expect(service.assignTask("B999", "worker")).rejects.toBeInstanceOf(BoardNotFoundError);

      await service.createTask({ title: "First", createdBy: actor });
      await service.createTask({ title: "Second", createdBy: actor });
      await service.addDependency("B2", "B1");
      await expect(service.addDependency("B1", "B2")).rejects.toBeInstanceOf(BoardDependencyConflictError);

      await service.blockTask("B1", "waiting");
      await expect(service.startTask("B1")).rejects.toBeInstanceOf(BoardInvalidTransitionError);

      await service.setLimits({ global: 1, perAssignee: 1, perConversation: 1 });
      await service.unblockTask("B1");
      await service.startTask("B1");
      await service.createTask({
        title: "Third",
        createdBy: { ...actor, conversationKey: "chat:2" },
      });
      await expect(service.startTask("B3")).rejects.toBeInstanceOf(BoardWipLimitError);
    } finally {
      await removeTempRoot(root);
    }
  });
});
