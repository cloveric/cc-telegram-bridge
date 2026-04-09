import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Bridge } from "../runtime/bridge.js";
import { appendAuditEvent } from "../state/audit-log.js";
import {
  chunkTelegramMessage,
  renderAccessCheckMessage,
  renderAttachmentDownloadMessage,
  renderErrorMessage,
  renderExecutionMessage,
  renderUnauthorizedMessage,
  renderWorkingMessage,
} from "./message-renderer.js";
import { TelegramApi } from "./api.js";
import type { NormalizedTelegramAttachment, NormalizedTelegramMessage } from "./update-normalizer.js";

export interface TelegramDeliveryContext {
  api: TelegramApi;
  bridge: Bridge;
  inboxDir: string;
  instanceName?: string;
  updateId?: number;
}

function inferExtension(attachment: NormalizedTelegramAttachment, telegramFilePath: string): string {
  const explicitExtension = attachment.fileName ? path.extname(attachment.fileName) : "";
  if (explicitExtension) {
    return explicitExtension;
  }

  const filePathExtension = path.extname(telegramFilePath);
  if (filePathExtension) {
    return filePathExtension;
  }

  if (attachment.kind === "photo") {
    return ".jpg";
  }

  return "";
}

function buildInboxFileName(attachment: NormalizedTelegramAttachment, telegramFilePath: string): string {
  const extension = inferExtension(attachment, telegramFilePath);
  const explicitBaseName = attachment.fileName ? path.basename(attachment.fileName, path.extname(attachment.fileName)) : "";
  const safeBaseName = explicitBaseName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (safeBaseName) {
    return `${attachment.fileId}-${safeBaseName}${extension}`;
  }

  return `${attachment.fileId}${extension}`;
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

async function downloadAttachments(
  api: TelegramApi,
  inboxDir: string,
  attachments: NormalizedTelegramAttachment[],
): Promise<string[]> {
  if (attachments.length === 0) {
    return [];
  }

  await ensureInboxDirExists(inboxDir);
  const downloadedFiles: string[] = [];

  for (const attachment of attachments) {
    const telegramFile = await api.getFile(attachment.fileId);
    const destinationPath = path.join(inboxDir, buildInboxFileName(attachment, telegramFile.file_path));
    await api.downloadFile(telegramFile.file_path, destinationPath);
    downloadedFiles.push(destinationPath);
  }

  return downloadedFiles;
}

async function deliverTelegramResponse(
  api: TelegramApi,
  chatId: number,
  placeholderMessageId: number,
  text: string,
  onPlaceholderDelivered: () => void,
): Promise<void> {
  const fileMatch = text.match(/```file:([^\n]+)\n([\s\S]*?)```/);
  if (fileMatch) {
    const [, fileName, fileBody] = fileMatch;
    await api.editMessage(chatId, placeholderMessageId, `Sending file: ${fileName.trim()}`);
    onPlaceholderDelivered();
    await api.sendDocument(chatId, fileName.trim(), fileBody);
    return;
  }

  const chunks = chunkTelegramMessage(text);
  const [firstChunk = ""] = chunks;

  await api.editMessage(chatId, placeholderMessageId, firstChunk);
  onPlaceholderDelivered();

  for (const chunk of chunks.slice(1)) {
    await api.sendMessage(chatId, chunk);
  }
}

export async function handleNormalizedTelegramMessage(
  normalized: NormalizedTelegramMessage,
  context: TelegramDeliveryContext,
): Promise<void> {
  const startedAt = Date.now();
  let placeholderMessageId: number | undefined;
  let placeholderShowsResponse = false;
  let progressEditsClosed = false;
  let progressEditChain = Promise.resolve();
  let progressEditCounter = 0;
  let lastAllowedProgressEditCounter = Number.POSITIVE_INFINITY;

  try {
    const placeholder = await context.api.sendMessage(normalized.chatId, renderWorkingMessage());
    placeholderMessageId = placeholder.message_id;
    await context.api.editMessage(normalized.chatId, placeholderMessageId, renderAccessCheckMessage());

    const accessDecision = await context.bridge.checkAccess({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
    });

    if (accessDecision.kind === "reply" || accessDecision.kind === "deny") {
      await context.api.editMessage(
        normalized.chatId,
        placeholderMessageId,
        accessDecision.text ?? renderErrorMessage(renderUnauthorizedMessage()),
      );
      await appendAuditEvent(path.dirname(context.inboxDir), {
        type: "update.reply",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "reply",
        detail: accessDecision.text,
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
        },
      });
      return;
    }

    if (normalized.attachments.length > 0) {
      await context.api.editMessage(
        normalized.chatId,
        placeholderMessageId,
        renderAttachmentDownloadMessage(normalized.attachments.length),
      );
    }

    const files = await downloadAttachments(context.api, context.inboxDir, normalized.attachments);
    await context.api.editMessage(normalized.chatId, placeholderMessageId, renderExecutionMessage());

    let lastProgressEdit = 0;
    const PROGRESS_THROTTLE_MS = 2000;
    const progressMessageId = placeholderMessageId;
    const onProgress = (partialText: string) => {
      if (progressMessageId === undefined) return;
      const now = Date.now();
      if (now - lastProgressEdit < PROGRESS_THROTTLE_MS) return;
      if (!partialText || partialText.length < 5) return;
      lastProgressEdit = now;
      const preview = partialText.length > 4000 ? `${partialText.slice(-4000)}\n\n...` : partialText;
      const progressId = ++progressEditCounter;
      progressEditChain = progressEditChain
        .catch(() => {})
        .then(async () => {
          if (progressId > lastAllowedProgressEditCounter) {
            return;
          }

          await context.api.editMessage(normalized.chatId, progressMessageId, preview);
        })
        .catch(() => {});
    };

    const result = await context.bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      text: normalized.text,
      replyContext: normalized.replyContext,
      files,
      onProgress,
    });

    progressEditsClosed = true;
    lastAllowedProgressEditCounter = progressEditCounter;
    await progressEditChain;
    await deliverTelegramResponse(context.api, normalized.chatId, placeholderMessageId, result.text, () => {
      placeholderShowsResponse = true;
    });
    await appendAuditEvent(path.dirname(context.inboxDir), {
      type: "update.handle",
      instanceName: context.instanceName,
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        attachments: normalized.attachments.length,
        responseChars: result.text.length,
        chunkCount: chunkTelegramMessage(result.text).length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progressEditsClosed = true;
    lastAllowedProgressEditCounter = progressEditCounter;
    await progressEditChain;

    if (placeholderShowsResponse) {
      await context.api.sendMessage(normalized.chatId, renderErrorMessage(message));
    } else if (placeholderMessageId !== undefined) {
      await context.api.editMessage(normalized.chatId, placeholderMessageId, renderErrorMessage(message));
    } else {
      await context.api.sendMessage(normalized.chatId, renderErrorMessage(message));
    }

    await appendAuditEvent(path.dirname(context.inboxDir), {
      type: "update.handle",
      instanceName: context.instanceName,
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      outcome: "error",
      detail: message,
      metadata: {
        durationMs: Date.now() - startedAt,
        attachments: normalized.attachments.length,
      },
    });

    throw error;
  }
}
