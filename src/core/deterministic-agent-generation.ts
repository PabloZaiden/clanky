import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { ModelConfig } from "@/shared/model";
import { DETERMINISTIC_AGENT_CODE_CONTRACT } from "@/shared/deterministic-agent";
import { isChatBusyStatus } from "@/shared/chat";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "./domain-error";
import { backendManager } from "./backend";
import { chatManager } from "./chat-manager";
import type { CommandExecutor } from "./command-executor";
import { validateDeterministicAgentCode } from "./deterministic-agent-code";
import {
  createInterruptibleOperationCoordinator,
  INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS,
} from "./interruptible-operation";

const log = createLogger("deterministic-agent-generation");
const GENERATION_SOURCE_POLL_INTERVAL_MS = 100;
const GENERATION_SOURCE_TIMEOUT_MS = 15 * 60 * 1000;
const GENERATION_COMPLETE_MARKER = "complete";
const GENERATION_SOURCE_PATH_MARKER = "Write only raw TypeScript source to this exact absolute file path:";
const GENERATION_REPAIR_TURN_LIMIT = 1;

export interface GenerateDeterministicAgentCodeOptions {
  chatId: string;
  name: string;
  prompt: string;
  previousCode: string;
  workspaceId: string;
  directory: string;
  model: ModelConfig;
  message?: string;
  attachments?: MessageImageAttachment[];
  signal?: AbortSignal;
}

export interface GeneratedDeterministicAgentCode {
  code: string;
  diagnostics: ReturnType<typeof validateDeterministicAgentCode>;
}

export function getGenerationSourceFilePath(directory: string, chatId: string): string {
  const filename = `.clanky-deterministic-agent-${chatId}.ts`;
  return directory.endsWith("/") ? `${directory}${filename}` : `${directory}/${filename}`;
}

function createGenerationCompletionFilePath(filePath: string): string {
  return `${filePath}.complete`;
}

function buildContractInstructions(): string[] {
  return [
    "The complete deterministic-agent context type shape is:",
    ...DETERMINISTIC_AGENT_CODE_CONTRACT.contextTypes.flatMap((contextType) => [
      "---",
      contextType,
      "---",
    ]),
    "Runtime semantics:",
    ...DETERMINISTIC_AGENT_CODE_CONTRACT.runtimeSemantics.map((semantic) => `- ${semantic}`),
    "Node.js and safety restrictions:",
    ...DETERMINISTIC_AGENT_CODE_CONTRACT.nodeRestrictions.map((restriction) => `- ${restriction}`),
    "Contract summary:",
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.exportRule}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.asyncRule}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.exec}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.prompt}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.output}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.signal}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.restrictions}`,
    `- ${DETERMINISTIC_AGENT_CODE_CONTRACT.visibility}`,
    "Examples:",
    ...DETERMINISTIC_AGENT_CODE_CONTRACT.examples.flatMap((example) => [
      `Example: ${example.title}`,
      example.description,
      "---",
      example.code,
      "---",
    ]),
  ];
}

function buildGenerationPrompt(
  options: GenerateDeterministicAgentCodeOptions,
  outputFilePath: string,
  completionFilePath: string,
): string {
  const previousCode = options.previousCode.trim() || "(no previous code)";
  return [
    "Generate the complete TypeScript source for a Clanky deterministic agent.",
    "Use your workspace file tools to write the source instead of returning it in your response.",
    GENERATION_SOURCE_PATH_MARKER,
    "---",
    outputFilePath,
    "---",
    "Create or overwrite that file and verify that it contains the complete source before finishing.",
    "Only after the source is complete and verified, write the exact text "
      + `"${GENERATION_COMPLETE_MARKER}" to this separate marker file:`,
    "---",
    completionFilePath,
    "---",
    "Do not create or update the marker file until the source file is complete.",
    "For every later user message in this same conversation, treat it as a request to revise the source, "
      + "write the complete updated source to the same file, verify it, and then update the marker file.",
    "Do not include Markdown fences, explanations, or any other text in the source file.",
    "After writing and verifying the file, reply with a short confirmation only; do not paste the source in your response.",
    ...buildContractInstructions(),
    "",
    "Generation inputs:",
    "Agent name:",
    "---",
    options.name,
    "---",
    "Requested behavior:",
    "---",
    options.prompt,
    "---",
    "Previous generated code:",
    "---",
    previousCode,
    "---",
  ].join("\n");
}

function buildGenerationFollowUpMessage(
  options: GenerateDeterministicAgentCodeOptions,
  outputFilePath: string,
  completionFilePath: string,
): string {
  const previousCode = options.previousCode.trim() || "(no previous code)";
  const message = options.message?.trim() || "(apply the attached follow-up instructions)";
  return [
    "Continue the deterministic-agent generation conversation using the same runtime contract.",
    ...buildContractInstructions(),
    "",
    "Generation inputs:",
    "Agent name:",
    "---",
    options.name,
    "---",
    "Existing requested behavior:",
    "---",
    options.prompt,
    "---",
    "Previous generated code:",
    "---",
    previousCode,
    "---",
    "Follow-up request:",
    "---",
    message,
    "---",
    "Apply the follow-up request to the deterministic agent source.",
    GENERATION_SOURCE_PATH_MARKER,
    "---",
    outputFilePath,
    "---",
    "Write and verify the complete updated source before writing the exact text "
      + `"${GENERATION_COMPLETE_MARKER}" to this separate marker file:`,
    "---",
    completionFilePath,
    "---",
    "Reply with a short confirmation only; do not paste the source.",
  ].join("\n");
}

function formatGenerationDiagnostics(
  diagnostics: GeneratedDeterministicAgentCode["diagnostics"],
): string {
  return diagnostics.map((diagnostic, index) => {
    const location = diagnostic.line
      ? `line ${diagnostic.line}${diagnostic.column ? `, column ${diagnostic.column}` : ""}`
      : "source";
    return `${index + 1}. ${location}: ${diagnostic.message}`;
  }).join("\n");
}

function buildGenerationRepairMessage(
  options: GenerateDeterministicAgentCodeOptions,
  outputFilePath: string,
  completionFilePath: string,
  diagnostics: GeneratedDeterministicAgentCode["diagnostics"],
): string {
  return [
    "The generated deterministic-agent source failed validation.",
    "Repair the source now. Do not explain the fix and do not paste source in your response.",
    ...buildContractInstructions(),
    "",
    "Generation inputs:",
    "Agent name:",
    "---",
    options.name,
    "---",
    "Requested behavior:",
    "---",
    options.prompt,
    "---",
    "Current source file to repair:",
    "---",
    outputFilePath,
    "---",
    "Validation diagnostics:",
    "---",
    formatGenerationDiagnostics(diagnostics),
    "---",
    "Read the current source file, fix every listed diagnostic, and rewrite the complete source to that same path.",
    "Verify the complete source before writing the exact text "
      + `"${GENERATION_COMPLETE_MARKER}" to this marker file:`,
    "---",
    completionFilePath,
    "---",
    "This is the only automatic repair turn. Reply with a short confirmation only.",
  ].join("\n");
}

async function waitForGenerationPoll(signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await awaitWithAbort(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, GENERATION_SOURCE_POLL_INTERVAL_MS);
      }),
      signal,
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function removeGenerationFileOrThrow(
  executor: CommandExecutor,
  directory: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await awaitWithAbort(
    executor.exec("rm", ["-f", "--", filePath], {
      cwd: directory,
      timeout: 10_000,
      logFailures: false,
      signal,
    }),
    signal,
  );
  if (!result.success) {
    throw new DomainError(
      "agent_code_generation_failed",
      `Could not invalidate the generation completion marker: ${result.stderr || result.exitCode}`,
    );
  }
}

async function waitForGeneratedAgentSource(
  executor: CommandExecutor,
  chatId: string,
  outputFilePath: string,
  completionFilePath: string,
  options: {
    requireNewTurn: boolean;
    initialSource?: string;
    signal?: AbortSignal;
  },
): Promise<GeneratedDeterministicAgentCode> {
  const startedAt = Date.now();
  let previousSource: string | undefined;
  let stableSourcePolls = 0;
  let observedBusy = false;

  while (true) {
    const chat = await awaitWithAbort(chatManager.getChat(chatId), options.signal);
    if (!chat) {
      throw new DomainError(
        "agent_code_generation_failed",
        `Generation chat not found: ${chatId}`,
      );
    }
    const chatIsBusy = isChatBusyStatus(chat.state.status);
    observedBusy ||= chatIsBusy;
    if (chat.state.status === "failed" || chat.state.error) {
      throw new DomainError(
        "agent_code_generation_failed",
        chat.state.error?.message ?? "The code generation chat failed",
      );
    }

    const source = await executor.readFile(outputFilePath, { signal: options.signal });
    const normalizedSource = source?.trim() || undefined;
    const completionMarker = await executor.readFile(completionFilePath, { signal: options.signal });
    const markerComplete = completionMarker?.trim() === GENERATION_COMPLETE_MARKER;

    if (normalizedSource) {
      const diagnostics = validateDeterministicAgentCode(normalizedSource);
      if (previousSource === normalizedSource) {
        stableSourcePolls += 1;
      } else {
        stableSourcePolls = 0;
      }
      const sourceChanged = normalizedSource !== options.initialSource;
      const turnFinished = markerComplete
        || (!chatIsBusy && (!options.requireNewTurn || observedBusy || sourceChanged));
      if (stableSourcePolls >= 1 && turnFinished) {
        return { code: normalizedSource, diagnostics };
      }
      previousSource = normalizedSource;
    } else {
      previousSource = undefined;
      stableSourcePolls = 0;
      if (!chatIsBusy && (!options.requireNewTurn || observedBusy)) {
        throw new DomainError(
          "agent_code_generation_failed",
          "The code generation provider did not create a non-empty source file",
        );
      }
    }

    if (Date.now() - startedAt > GENERATION_SOURCE_TIMEOUT_MS) {
      throw new DomainError(
        "agent_code_generation_failed",
        "Timed out waiting for the code generation provider to finish writing the source file",
      );
    }
    await waitForGenerationPoll(options.signal);
  }
}

async function removeGenerationFile(
  executor: CommandExecutor,
  directory: string,
  filePath: string,
): Promise<void> {
  try {
    const result = await executor.exec("rm", ["-f", "--", filePath], {
      cwd: directory,
      timeout: 10_000,
      logFailures: false,
    });
    if (!result.success) {
      throw new Error(result.stderr || `rm exited with code ${result.exitCode}`);
    }
  } catch (error) {
    log.warn("Failed to clean up deterministic agent generation file", {
      filePath,
      error: String(error),
    });
  }
}

export async function cleanupDeterministicAgentGenerationFiles(
  workspaceId: string,
  directory: string,
  chatId: string,
  existingExecutor?: CommandExecutor,
): Promise<void> {
  const executor = existingExecutor
    ?? await backendManager.getCommandExecutorAsync(workspaceId, directory);
  const outputFilePath = getGenerationSourceFilePath(directory, chatId);
  await removeGenerationFile(executor, directory, outputFilePath);
  await removeGenerationFile(executor, directory, createGenerationCompletionFilePath(outputFilePath));
}

async function restoreGenerationDraftAfterAbort(
  executor: CommandExecutor,
  directory: string,
  outputFilePath: string,
  completionFilePath: string,
  previousCode: string,
): Promise<void> {
  if (previousCode.trim()) {
    const restored = await executor.writeFile(outputFilePath, previousCode);
    if (!restored) {
      log.warn("Failed to restore deterministic agent generation draft after cancellation", {
        filePath: outputFilePath,
      });
    }
  } else {
    await removeGenerationFile(executor, directory, outputFilePath);
  }
  await removeGenerationFile(executor, directory, completionFilePath);
}

function createAbortError(): DOMException {
  return new DOMException("Deterministic agent code generation was cancelled", "AbortError");
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return operation;
  }
  if (signal.aborted) {
    throw createAbortError();
  }

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => reject(createAbortError());
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

export async function generateDeterministicAgentCode(
  options: GenerateDeterministicAgentCodeOptions,
): Promise<GeneratedDeterministicAgentCode> {
  if (options.signal?.aborted) {
    throw createAbortError();
  }

  const executor = await awaitWithAbort(
    backendManager.getCommandExecutorAsync(options.workspaceId, options.directory),
    options.signal,
  );
  const outputFilePath = getGenerationSourceFilePath(options.directory, options.chatId);
  const completionFilePath = createGenerationCompletionFilePath(outputFilePath);
  const isFollowUp = options.message !== undefined || (options.attachments?.length ?? 0) > 0;
  const initialSource = isFollowUp ? options.previousCode.trim() || undefined : undefined;
  const coordinator = createInterruptibleOperationCoordinator({
    signal: options.signal,
    interrupt: async () => {
      await chatManager.interruptChat(
        options.chatId,
        "Deterministic agent code generation was cancelled",
      );
    },
    settlementTimeoutMs: INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS,
    createAbortError,
    onInterruptError: (error, phase) => {
      log.warn("Failed to interrupt deterministic agent code generation chat", {
        chatId: options.chatId,
        phase,
        error: String(error),
      });
    },
    onSettlementTimeout: (phaseName) => {
      log.warn("Deterministic agent code generation chat did not settle after cancellation", {
        chatId: options.chatId,
        phase: phaseName,
      });
    },
  });

  try {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    if (isFollowUp) {
      const source = options.previousCode.trim();
      if (source) {
        const written = await awaitWithAbort(executor.writeFile(outputFilePath, source), options.signal);
        if (!written) {
          throw new DomainError("agent_code_generation_failed", "Could not prepare the generation source file");
        }
      } else {
        await awaitWithAbort(
          executor.exec("rm", ["-f", "--", outputFilePath], {
            cwd: options.directory,
            timeout: 10_000,
            logFailures: false,
            signal: options.signal,
          }),
          options.signal,
        );
      }
      await awaitWithAbort(
        executor.exec("rm", ["-f", "--", completionFilePath], {
          cwd: options.directory,
          timeout: 10_000,
          logFailures: false,
          signal: options.signal,
        }),
        options.signal,
      );
    } else {
      const clearResult = await awaitWithAbort(
        executor.exec("rm", ["-f", "--", outputFilePath, completionFilePath], {
          cwd: options.directory,
          timeout: 10_000,
          logFailures: false,
          signal: options.signal,
        }),
        options.signal,
      );
      if (!clearResult.success) {
        throw new DomainError(
          "agent_code_generation_failed",
          `Could not prepare the generation file: ${clearResult.stderr || clearResult.exitCode}`,
        );
      }
    }

    const message = isFollowUp
      ? buildGenerationFollowUpMessage(options, outputFilePath, completionFilePath)
      : buildGenerationPrompt(options, outputFilePath, completionFilePath);
    await coordinator.runPhase(
      () => chatManager.sendMessage(options.chatId, {
        message,
        attachments: options.attachments,
      }),
      "send",
    );
    let generated = await waitForGeneratedAgentSource(
      executor,
      options.chatId,
      outputFilePath,
      completionFilePath,
      {
        requireNewTurn: isFollowUp,
        initialSource,
        signal: options.signal,
      },
    );
    for (let repairTurn = 0; generated.diagnostics.length > 0 && repairTurn < GENERATION_REPAIR_TURN_LIMIT; repairTurn += 1) {
      await awaitWithAbort(
        chatManager.waitForChatIdle(options.chatId),
        options.signal,
      );
      await removeGenerationFileOrThrow(
        executor,
        options.directory,
        completionFilePath,
        options.signal,
      );
      await coordinator.runPhase(
        () => chatManager.sendMessage(options.chatId, {
          message: buildGenerationRepairMessage(
            options,
            outputFilePath,
            completionFilePath,
            generated.diagnostics,
          ),
        }),
        "repair",
      );
      generated = await waitForGeneratedAgentSource(
        executor,
        options.chatId,
        outputFilePath,
        completionFilePath,
        {
          requireNewTurn: true,
          initialSource: generated.code,
          signal: options.signal,
        },
      );
    }
    return generated;
  } finally {
    await coordinator.dispose();
    if (options.signal?.aborted) {
      await restoreGenerationDraftAfterAbort(
        executor,
        options.directory,
        outputFilePath,
        completionFilePath,
        options.previousCode,
      );
    }
  }
}
