import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Bridge } from "../runtime/bridge.js";
import {
  FileWorkflowPreparationError,
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow,
  type DownloadedAttachment,
} from "../runtime/file-workflow.js";
import {
  applyTelegramOutLimits,
  createTelegramOutDir,
  describeTelegramOutFiles,
} from "../runtime/telegram-out.js";
import { appendAuditEvent } from "../state/audit-log.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { UsageStore } from "../state/usage-store.js";
import { readFile } from "node:fs/promises";
import { SessionStore } from "../state/session-store.js";
import { SessionStateError } from "../runtime/session-manager.js";
import { delegateToInstance } from "../bus/bus-client.js";

interface InstanceConfig {
  engine: "codex" | "claude";
  locale: "en" | "zh";
  verbosity: 0 | 1 | 2;
  budgetUsd: number | undefined;
}

async function loadInstanceConfig(stateDir: string): Promise<InstanceConfig> {
  try {
    const raw = await readFile(path.join(stateDir, "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      engine?: string;
      locale?: string;
      verbosity?: number;
      budgetUsd?: number;
    };
    return {
      engine: config.engine === "claude" ? "claude" : "codex",
      locale: config.locale === "zh" ? "zh" : "en",
      verbosity: config.verbosity === 0 ? 0 : config.verbosity === 2 ? 2 : 1,
      budgetUsd: typeof config.budgetUsd === "number" && config.budgetUsd > 0 ? config.budgetUsd : undefined,
    };
  } catch {
    return { engine: "codex", locale: "en", verbosity: 1, budgetUsd: undefined };
  }
}

async function appendAuditEventBestEffort(stateDir: string, event: Parameters<typeof appendAuditEvent>[1]): Promise<void> {
  try {
    await appendAuditEvent(stateDir, event);
  } catch {
    // Fast-path success responses should remain successful even if audit persistence fails late.
  }
}

async function updateWorkflowBestEffort(
  workflowStore: FileWorkflowStore,
  workflowRecordId: string,
  mutate: Parameters<FileWorkflowStore["update"]>[1],
): Promise<void> {
  try {
    await workflowStore.update(workflowRecordId, mutate);
  } catch {
    // Visible Telegram delivery already succeeded; workflow persistence is bookkeeping-only now.
  }
}

import {
  chunkTelegramMessage,
  renderAttachmentDownloadMessage,
  renderCategorizedErrorMessage,
  renderErrorMessage,
  renderExecutionMessage,
  renderTelegramHelpMessage,
  renderTelegramStatusMessage,
  renderUnauthorizedMessage,
  renderSessionStateErrorMessage,
  renderSessionResetMessage,
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

function wantsTelegramOut(text: string): boolean {
  return /(发.*文件|传.*文件|发送.*文件|导出.*文件|文件.*传|文件.*发|生成.*文件|generate.*file|send.*file|export.*file)/i.test(text);
}

function isResetCommand(text: string): boolean {
  return /^\/reset(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isHelpCommand(text: string): boolean {
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function isStatusCommand(text: string): boolean {
  return /^\/status(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function parseAskCommand(text: string): { targetInstance: string; prompt: string } | null {
  const match = text.trim().match(/^\/ask(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }
  return { targetInstance: match[1]!, prompt: match[2]!.trim() };
}

function isBlockingWorkflowStatus(status: "preparing" | "processing" | "awaiting_continue" | "completed" | "failed"): boolean {
  return status === "preparing" || status === "processing" || status === "failed";
}

function shouldUseNonRepairableResetSessionGuidance(
  error: unknown,
  failureCategory: ReturnType<typeof classifyFailure>,
  originalText: string,
): boolean {
  if (!isResetCommand(originalText)) {
    return false;
  }

  if (error instanceof SessionStateError) {
    return !error.repairable;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((((error as NodeJS.ErrnoException).code === "EACCES") || (error as NodeJS.ErrnoException).code === "EPERM"))
  ) {
    return true;
  }

  if (failureCategory === "session-state") {
    return true;
  }

  const errorText =
    error instanceof Error
      ? `${error.name}\n${error.message}`.toLowerCase()
      : String(error).toLowerCase();

  return (
    errorText.includes("session state") ||
    errorText.includes("session-store") ||
    errorText.includes("session store") ||
    errorText.includes("session binding")
  );
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

function buildContinueAnalysisKeyboard(uploadId: string) {
  return {
    inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${uploadId}` }]],
  };
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

async function downloadAttachments(
  api: TelegramApi,
  inboxDir: string,
  attachments: NormalizedTelegramAttachment[],
): Promise<DownloadedAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  await ensureInboxDirExists(inboxDir);
  const downloadedFiles: DownloadedAttachment[] = [];

  for (const attachment of attachments) {
    const telegramFile = await api.getFile(attachment.fileId);
    const destinationPath = path.join(inboxDir, buildInboxFileName(attachment, telegramFile.file_path));
    await api.downloadFile(telegramFile.file_path, destinationPath);
    downloadedFiles.push({
      attachment,
      localPath: destinationPath,
    });
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
  let workflowRecordId: string | undefined;
  let archiveSummaryDelivered = false;
  let telegramOutDirPath: string | undefined;
  let failureHint: string | undefined;
  const stateDir = path.dirname(context.inboxDir);
  const workflowStore = new FileWorkflowStore(stateDir);
  const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
  const cfg = await loadInstanceConfig(stateDir);
  const locale = cfg.locale;

  try {
    if (normalized.callbackQueryId) {
      try {
        await context.api.answerCallbackQuery(normalized.callbackQueryId);
      } catch {
        // Callback acks are advisory; continuation should still proceed.
      }
    }
    const placeholder = await context.api.sendMessage(normalized.chatId, renderWorkingMessage(locale));
    placeholderMessageId = placeholder.message_id;

    const accessDecision = await context.bridge.checkAccess({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
    });

    if (accessDecision.kind === "reply" || accessDecision.kind === "deny") {
      await context.api.editMessage(
        normalized.chatId,
        placeholderMessageId,
        accessDecision.text ?? renderErrorMessage(renderUnauthorizedMessage(locale), locale),
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

    if (isResetCommand(normalized.text)) {
      const inspectedState = await sessionStore.inspect();
      if (inspectedState.warning) {
        throw new SessionStateError(
          inspectedState.repairable
            ? "Session state is unreadable right now. The operator needs to repair session state and retry."
            : "Session state is unavailable right now. The operator needs to restore read access and retry.",
          inspectedState.repairable ?? false,
        );
      }

      await sessionStore.removeByChatId(normalized.chatId);
      const resetMessage = renderSessionResetMessage(false, locale);
      await context.api.editMessage(normalized.chatId, placeholderMessageId, resetMessage);
      placeholderShowsResponse = true;
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: resetMessage.length,
          chunkCount: chunkTelegramMessage(resetMessage).length,
        },
      });
      return;
    }

    if (isHelpCommand(normalized.text)) {
      const helpMessage = renderTelegramHelpMessage(locale);
      await context.api.editMessage(normalized.chatId, placeholderMessageId, helpMessage);
      placeholderShowsResponse = true;
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: helpMessage.length,
          chunkCount: chunkTelegramMessage(helpMessage).length,
        },
      });
      return;
    }

    if (isStatusCommand(normalized.text)) {
      const sessionResult = await sessionStore.findByChatIdSafe(normalized.chatId);
      const workflowResult = await workflowStore.inspect();
      const chatRecords = workflowResult.warning
        ? []
        : workflowResult.state.records.filter((record) => record.chatId === normalized.chatId);
      const blockingTasks = workflowResult.warning
        ? null
        : chatRecords.filter((record) => isBlockingWorkflowStatus(record.status)).length;
      const waitingTasks = workflowResult.warning
        ? null
        : chatRecords.filter((record) => record.status === "awaiting_continue").length;
      const statusMessage = renderTelegramStatusMessage({
        engine: cfg.engine,
        sessionBound: sessionResult.warning ? null : sessionResult.record !== null,
        blockingTasks,
        waitingTasks,
        sessionWarning: sessionResult.warning,
        taskStateWarning: workflowResult.warning,
      }, locale);
      await context.api.editMessage(normalized.chatId, placeholderMessageId, statusMessage);
      placeholderShowsResponse = true;
      await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: statusMessage.length,
          chunkCount: chunkTelegramMessage(statusMessage).length,
        },
      });
      return;
    }

    const askCommand = parseAskCommand(normalized.text);
    if (askCommand) {
      const currentInstance = context.instanceName ?? "default";
      if (askCommand.targetInstance === currentInstance) {
        await context.api.editMessage(normalized.chatId, placeholderMessageId,
          locale === "zh" ? "不能委托给自己。" : "Cannot delegate to yourself.");
        placeholderShowsResponse = true;
        return;
      }

      const askLabel = locale === "zh"
        ? `正在转发给 ${askCommand.targetInstance}...`
        : `Delegating to ${askCommand.targetInstance}...`;
      await context.api.editMessage(normalized.chatId, placeholderMessageId, askLabel);

      try {
        const result = await delegateToInstance({
          fromInstance: currentInstance,
          targetInstance: askCommand.targetInstance,
          prompt: askCommand.prompt,
          depth: 0,
          stateDir,
        });

        const askResponse = locale === "zh"
          ? `[来自 ${askCommand.targetInstance}]\n\n${result.text}`
          : `[From ${askCommand.targetInstance}]\n\n${result.text}`;
        const chunks = chunkTelegramMessage(askResponse);
        await context.api.editMessage(normalized.chatId, placeholderMessageId, chunks[0]!);
        placeholderShowsResponse = true;
        for (const chunk of chunks.slice(1)) {
          await context.api.sendMessage(normalized.chatId, chunk);
        }

        await appendAuditEventBestEffort(stateDir, {
          type: "update.handle",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          outcome: "success",
          metadata: {
            durationMs: Date.now() - startedAt,
            delegatedTo: askCommand.targetInstance,
            responseChars: askResponse.length,
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const errorMsg = locale === "zh"
          ? `委托给 ${askCommand.targetInstance} 失败：${detail}`
          : `Delegation to ${askCommand.targetInstance} failed: ${detail}`;
        await context.api.editMessage(normalized.chatId, placeholderMessageId, errorMsg);
        placeholderShowsResponse = true;
        await appendAuditEventBestEffort(stateDir, {
          type: "update.handle",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          outcome: "error",
          detail,
          metadata: { durationMs: Date.now() - startedAt, delegatedTo: askCommand.targetInstance },
        });
      }
      return;
    }

    if (normalized.attachments.length > 0) {
      await context.api.editMessage(
        normalized.chatId,
        placeholderMessageId,
        renderAttachmentDownloadMessage(normalized.attachments.length, locale),
      );
    }

    const downloadedAttachments = await downloadAttachments(context.api, context.inboxDir, normalized.attachments);

    const workflowResult =
      downloadedAttachments.length > 0
        ? await prepareAttachmentWorkflow({
            stateDir,
            chatId: normalized.chatId,
            userId: normalized.userId,
            text: normalized.text,
            downloadedAttachments,
          })
        : await prepareArchiveContinueWorkflow({
            stateDir,
            chatId: normalized.chatId,
            text: normalized.text,
            replyContext: normalized.replyContext,
          });
    failureHint = workflowResult?.failureHint;

    const engine = cfg.engine;
    if (engine === "codex" && wantsTelegramOut(normalized.text)) {
      telegramOutDirPath = (await createTelegramOutDir(stateDir, `${Date.now()}-${normalized.chatId}`)).dirPath;
    }

    if (workflowResult?.kind === "reply") {
      workflowRecordId = workflowResult.workflowRecordId;
      const deliveryText = workflowRecordId ? boundArchiveSummaryForTelegram(workflowResult.text) : workflowResult.text;
      if (downloadedAttachments.length > 0 && workflowResult.workflowRecordId) {
        await workflowStore.update(workflowResult.workflowRecordId, (record) => {
          record.summaryMessageId = placeholderMessageId;
        });
      }
      await context.api.editMessage(
        normalized.chatId,
        placeholderMessageId,
        deliveryText,
        downloadedAttachments.length > 0 && workflowResult.workflowRecordId
          ? buildContinueAnalysisKeyboard(workflowResult.workflowRecordId)
          : undefined,
      );
      if (workflowRecordId) {
        archiveSummaryDelivered = true;
        placeholderShowsResponse = true;
      }
      await appendAuditEventBestEffort(stateDir, {
        type: "update.handle",
        instanceName: context.instanceName,
        chatId: normalized.chatId,
        userId: normalized.userId,
        updateId: context.updateId,
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          attachments: normalized.attachments.length,
          responseChars: deliveryText.length,
          chunkCount: chunkTelegramMessage(deliveryText).length,
        },
      });
      return;
    }

    workflowRecordId = workflowResult?.workflowRecordId;
    const requestText = workflowResult?.kind === "direct" ? workflowResult.text : normalized.text;
    const requestFiles = workflowResult?.kind === "direct"
      ? workflowResult.files
      : downloadedAttachments.map((attachment) => attachment.localPath);

    await context.api.editMessage(normalized.chatId, placeholderMessageId, renderExecutionMessage(locale));

    const verbosity = cfg.verbosity;
    let lastProgressEdit = 0;
    const PROGRESS_THROTTLE_MS = verbosity === 2 ? 1000 : 2000;
    const progressMessageId = placeholderMessageId;
    const onProgress = (partialText: string) => {
      if (verbosity === 0) return;
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

    if (cfg.budgetUsd !== undefined) {
      const usageStore = new UsageStore(stateDir);
      const usage = await usageStore.load();
      if (usage.totalCostUsd >= cfg.budgetUsd) {
        const budgetMsg = locale === "zh"
          ? `预算已用尽：$${usage.totalCostUsd.toFixed(4)} / $${cfg.budgetUsd.toFixed(2)}。使用 \`telegram budget set <usd>\` 提高预算或 \`telegram budget clear\` 清除。`
          : `Budget exhausted: $${usage.totalCostUsd.toFixed(4)} used of $${cfg.budgetUsd.toFixed(2)}. Raise the budget with \`telegram budget set <usd>\` or clear it with \`telegram budget clear\`.`;
        await context.api.editMessage(
          normalized.chatId,
          placeholderMessageId,
          budgetMsg,
        );
        placeholderShowsResponse = true;
        await appendAuditEventBestEffort(stateDir, {
          type: "update.reply",
          instanceName: context.instanceName,
          chatId: normalized.chatId,
          userId: normalized.userId,
          updateId: context.updateId,
          outcome: "reply",
          detail: "budget exhausted",
        });
        return;
      }
    }

    const replyContext =
      workflowResult?.kind === "direct" &&
      (workflowResult.suppressReplyContext || workflowResult.text.includes("[Archive Analysis Context]"))
        ? undefined
        : normalized.replyContext;

    const result = await context.bridge.handleAuthorizedMessage({
      chatId: normalized.chatId,
      userId: normalized.userId,
      chatType: normalized.chatType,
      locale,
      text: requestText,
      replyContext,
      files: requestFiles,
      onProgress,
      requestOutputDir: telegramOutDirPath,
    });

    progressEditsClosed = true;
    lastAllowedProgressEditCounter = progressEditCounter;
    await progressEditChain;

    if (result.usage) {
      const usageStore = new UsageStore(stateDir);
      await usageStore.record({
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedTokens: result.usage.cachedTokens,
        costUsd: result.usage.costUsd,
      });

      if (cfg.budgetUsd !== undefined) {
        const postUsage = await usageStore.load();
        if (postUsage.totalCostUsd >= cfg.budgetUsd) {
          await appendAuditEventBestEffort(stateDir, {
            type: "update.reply",
            instanceName: context.instanceName,
            chatId: normalized.chatId,
            userId: normalized.userId,
            updateId: context.updateId,
            outcome: "reply",
            detail: `budget threshold reached: $${postUsage.totalCostUsd.toFixed(4)} / $${cfg.budgetUsd.toFixed(2)}`,
          });
        }
      }
    }

    await deliverTelegramResponse(context.api, normalized.chatId, placeholderMessageId, result.text, () => {
      placeholderShowsResponse = true;
    });

    if (telegramOutDirPath) {
      const describedFiles = await describeTelegramOutFiles(telegramOutDirPath);
      const limitedFiles = applyTelegramOutLimits(describedFiles, {
        maxFiles: 5,
        maxFileBytes: 512_000,
        maxTotalBytes: 1_500_000,
      });

      for (const file of limitedFiles.accepted) {
        const contents = await readFile(file.path);
        await context.api.sendDocument(normalized.chatId, file.name, contents);
      }
    }

    if (workflowRecordId) {
      await updateWorkflowBestEffort(workflowStore, workflowRecordId, (record) => {
        record.status = "completed";
      });
    }

    await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
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
    if (workflowRecordId === undefined && error instanceof FileWorkflowPreparationError) {
      workflowRecordId = error.workflowRecordId;
    }

    const classifiedError = error instanceof FileWorkflowPreparationError ? error.cause : error;
    const message = classifiedError instanceof Error ? classifiedError.message : String(classifiedError);
    const failureCategory = classifyFailure(classifiedError);
    const errorMessage = shouldUseNonRepairableResetSessionGuidance(classifiedError, failureCategory, normalized.text)
      ? renderSessionStateErrorMessage(false, locale)
      : classifiedError instanceof SessionStateError
      ? renderSessionStateErrorMessage(classifiedError.repairable, locale)
      : failureHint
      ? `${renderCategorizedErrorMessage(failureCategory, message, locale)}\n${failureHint}`
      : renderCategorizedErrorMessage(failureCategory, message, locale);
    let workflowCleanupError: unknown;
    progressEditsClosed = true;
    lastAllowedProgressEditCounter = progressEditCounter;
    await progressEditChain;

    if (workflowRecordId) {
      try {
        if (!archiveSummaryDelivered) {
          await workflowStore.update(workflowRecordId, (record) => {
            if (
              record.status === "preparing" ||
              record.status === "processing" ||
              record.status === "awaiting_continue"
            ) {
              record.status = "failed";
            }
          });
        }
      } catch (cleanupError) {
        workflowCleanupError = cleanupError;
      }
    }

    if (placeholderShowsResponse && !archiveSummaryDelivered) {
      await context.api.sendMessage(
        normalized.chatId,
        errorMessage,
      );
    } else if (!archiveSummaryDelivered && placeholderMessageId !== undefined) {
      await context.api.editMessage(
        normalized.chatId,
        placeholderMessageId,
        errorMessage,
      );
    } else if (!archiveSummaryDelivered) {
      await context.api.sendMessage(
        normalized.chatId,
        errorMessage,
      );
    }

    await appendAuditEventBestEffort(path.dirname(context.inboxDir), {
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
        failureCategory,
        workflowCleanupError:
          workflowCleanupError === undefined
            ? undefined
            : workflowCleanupError instanceof Error
              ? workflowCleanupError.message
              : String(workflowCleanupError),
      },
    });

    throw error;
  }
}
