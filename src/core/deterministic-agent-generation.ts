import type { ModelConfig } from "@/shared/model";
import { isChatBusyStatus, type Chat } from "@/shared/chat";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "./domain-error";
import { backendManager } from "./backend";
import { chatManager } from "./chat-manager";
import type { CommandExecutor } from "./command-executor";
import { validateDeterministicAgentCode } from "./deterministic-agent-code";

const log = createLogger("deterministic-agent-generation");
const GENERATION_SOURCE_POLL_INTERVAL_MS = 100;
const GENERATION_SOURCE_TIMEOUT_MS = 15 * 60 * 1000;
const GENERATION_COMPLETE_MARKER = "complete";
const GENERATION_INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

export interface GenerateDeterministicAgentCodeOptions {
  name: string;
  prompt: string;
  comments: string;
  previousCode: string;
  workspaceId: string;
  directory: string;
  model: ModelConfig;
  signal?: AbortSignal;
}

export interface GeneratedDeterministicAgentCode {
  code: string;
  diagnostics: ReturnType<typeof validateDeterministicAgentCode>;
}

function createGenerationFilePath(directory: string): string {
  const filename = `.clanky-deterministic-agent-${crypto.randomUUID()}.ts`;
  return directory.endsWith("/") ? `${directory}${filename}` : `${directory}/${filename}`;
}

function createGenerationCompletionFilePath(filePath: string): string {
  return `${filePath}.complete`;
}

function buildGenerationPrompt(
  options: GenerateDeterministicAgentCodeOptions,
  outputFilePath: string,
  completionFilePath: string,
): string {
  const previousCode = options.previousCode.trim() || "(no previous code)";
  const comments = options.comments.trim() || "(no additional comments)";
  return [
    "Generate the complete TypeScript source for a Clanky deterministic agent.",
    "Use your workspace file tools to write the source instead of returning it in your response.",
    "Write only raw TypeScript source to this exact absolute file path:",
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
    "Do not include Markdown fences, explanations, or any other text in the file.",
    "After writing and verifying the file, reply with a short confirmation only; do not paste the source in your response.",
    "The source must export a default function named run (ctx) or an anonymous default function.",
    "The function may be async and must use only the provided context.",
    "The context API is:",
    "  ctx.workspace.exec(command, args?, options?) -> Promise<{ exitCode, stdout, stderr }>",
    "  ctx.workspace.prompt(message) -> Promise<string>",
    "  ctx.stdout.write(text) and ctx.stderr.write(text) for observable output.",
    "  ctx.signal for cancellation.",
    "Commands run in the selected workspace and may use the injected Clanky CLI/API environment.",
    "Do not invent imports, credentials, filesystem access, or APIs outside this context.",
    "The user can only see text written to stdout and stderr. Never print secrets or any other information that should remain hidden to either stream.",
    "",
    "Agent prompt:",
    "---",
    options.prompt,
    "---",
    "User comments for this iteration:",
    "---",
    comments,
    "---",
    "Previous generated code:",
    "---",
    previousCode,
    "---",
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

async function waitForGeneratedAgentSource(
  executor: CommandExecutor,
  chatId: string,
  outputFilePath: string,
  completionFilePath: string,
  signal?: AbortSignal,
): Promise<GeneratedDeterministicAgentCode> {
  const startedAt = Date.now();
  let previousSource: string | undefined;
  let stableSourcePolls = 0;

  while (true) {
    const chat = await awaitWithAbort(chatManager.getChat(chatId), signal);
    if (!chat) {
      throw new DomainError(
        "agent_code_generation_failed",
        `Generation chat not found: ${chatId}`,
      );
    }
    if (chat.state.status === "failed" || chat.state.error) {
      throw new DomainError(
        "agent_code_generation_failed",
        chat.state.error?.message ?? "The code generation chat failed",
      );
    }

    const source = await executor.readFile(outputFilePath, { signal });
    const normalizedSource = source?.trim() || undefined;
    const completionMarker = await executor.readFile(completionFilePath, { signal });
    const markerComplete = completionMarker?.trim() === GENERATION_COMPLETE_MARKER;

    if (normalizedSource) {
      const diagnostics = validateDeterministicAgentCode(normalizedSource);
      const chatIsIdle = !isChatBusyStatus(chat.state.status);
      if (previousSource === normalizedSource) {
        stableSourcePolls += 1;
      } else {
        stableSourcePolls = 0;
      }
      if (stableSourcePolls >= 1 && (markerComplete || chatIsIdle)) {
        return { code: normalizedSource, diagnostics };
      }
      previousSource = normalizedSource;
    } else {
      previousSource = undefined;
      stableSourcePolls = 0;
      if (!isChatBusyStatus(chat.state.status)) {
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
    await waitForGenerationPoll(signal);
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

async function waitForPromiseSettlement(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function generateDeterministicAgentCode(
  options: GenerateDeterministicAgentCodeOptions,
): Promise<GeneratedDeterministicAgentCode> {
  if (options.signal?.aborted) {
    throw createAbortError();
  }

  let chat: Chat | undefined;
  let executor: CommandExecutor | undefined;
  let outputFilePath: string | undefined;
  let completionFilePath: string | undefined;
  let sendPromise: Promise<Chat> | undefined;
  let sendSettled = true;
  let interruptPromise: Promise<void> | undefined;
  let lateInterruptScheduled = false;
  const interruptChatSafely = async (): Promise<void> => {
    try {
      await chatManager.interruptChat(chat!.config.id, "Deterministic agent code generation was cancelled");
    } catch (error) {
      log.warn("Failed to interrupt deterministic agent code generation chat", {
        chatId: chat!.config.id,
        error: String(error),
      });
    }
  };
  const requestInterrupt = (): Promise<void> => {
    if (interruptPromise) {
      return interruptPromise;
    }
    interruptPromise = (async () => {
      await interruptChatSafely();
      if (sendPromise && !sendSettled) {
        if (!lateInterruptScheduled) {
          lateInterruptScheduled = true;
          void sendPromise.then(
            () => {
              void interruptChatSafely();
            },
            () => {
              void interruptChatSafely();
            },
          );
        }
        await waitForPromiseSettlement(sendPromise, GENERATION_INTERRUPT_SETTLE_TIMEOUT_MS);
        if (sendSettled) {
          await interruptChatSafely();
        } else {
          log.warn("Deterministic agent code generation chat did not settle after cancellation", {
            chatId: chat!.config.id,
          });
        }
      }
    })().finally(() => {
      interruptPromise = undefined;
    });
    return interruptPromise;
  };
  const abortHandler = (): void => {
    void requestInterrupt();
  };
  chat = await chatManager.createChat({
    name: `Generate code: ${options.name}`,
    workspaceId: options.workspaceId,
    scope: "workspace",
    modelProviderID: options.model.providerID,
    modelID: options.model.modelID,
    modelVariant: options.model.variant,
    useWorktree: false,
    autoApprovePermissions: true,
    directory: options.directory,
    syncBaseBranch: false,
    prepareWorktreeOnCreate: false,
  });

  try {
    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    executor = await awaitWithAbort(
      backendManager.getCommandExecutorAsync(options.workspaceId, options.directory),
      options.signal,
    );
    outputFilePath = createGenerationFilePath(options.directory);
    completionFilePath = createGenerationCompletionFilePath(outputFilePath);
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
        `Could not prepare the temporary generation file: ${clearResult.stderr || clearResult.exitCode}`,
      );
    }

    sendSettled = false;
    sendPromise = chatManager.sendMessage(chat.config.id, {
      message: buildGenerationPrompt(options, outputFilePath, completionFilePath),
    });
    void sendPromise.then(
      () => {
        sendSettled = true;
      },
      () => {
        sendSettled = true;
      },
    );
    if (options.signal?.aborted) {
      await requestInterrupt();
      throw createAbortError();
    }
    await awaitWithAbort(sendPromise, options.signal);
    return await waitForGeneratedAgentSource(
      executor,
      chat.config.id,
      outputFilePath,
      completionFilePath,
      options.signal,
    );
  } finally {
    if (options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
    if (options.signal?.aborted || (sendPromise && !sendSettled)) {
      await requestInterrupt();
    }
    if (executor && outputFilePath) {
      await removeGenerationFile(executor, options.directory, outputFilePath);
    }
    if (executor && completionFilePath) {
      await removeGenerationFile(executor, options.directory, completionFilePath);
    }
    if (chat) {
      try {
        await chatManager.deleteChat(chat.config.id);
      } catch (error) {
        log.warn("Failed to clean up deterministic agent code generation chat", {
          chatId: chat.config.id,
          error: String(error),
        });
      }
    }
  }
}
