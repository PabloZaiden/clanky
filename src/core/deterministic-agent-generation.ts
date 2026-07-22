import type { ModelConfig } from "@/shared/model";
import type { Chat } from "@/shared/chat";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "./domain-error";
import { backendManager } from "./backend";
import { chatManager } from "./chat-manager";
import type { CommandExecutor } from "./command-executor";
import { validateDeterministicAgentCode } from "./deterministic-agent-code";

const log = createLogger("deterministic-agent-generation");

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

function buildGenerationPrompt(
  options: GenerateDeterministicAgentCodeOptions,
  outputFilePath: string,
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

export async function generateDeterministicAgentCode(
  options: GenerateDeterministicAgentCodeOptions,
): Promise<GeneratedDeterministicAgentCode> {
  if (options.signal?.aborted) {
    throw createAbortError();
  }

  let chat: Chat | undefined;
  let executor: CommandExecutor | undefined;
  let outputFilePath: string | undefined;
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
    executor = await awaitWithAbort(
      backendManager.getCommandExecutorAsync(options.workspaceId, options.directory),
      options.signal,
    );
    outputFilePath = createGenerationFilePath(options.directory);
    const clearResult = await awaitWithAbort(
      executor.exec("rm", ["-f", "--", outputFilePath], {
        cwd: options.directory,
        timeout: 10_000,
        logFailures: false,
      }),
      options.signal,
    );
    if (!clearResult.success) {
      throw new DomainError(
        "agent_code_generation_failed",
        `Could not prepare the temporary generation file: ${clearResult.stderr || clearResult.exitCode}`,
      );
    }

    await awaitWithAbort(
      chatManager.sendMessage(chat.config.id, {
        message: buildGenerationPrompt(options, outputFilePath),
      }),
      options.signal,
    );
    const completed = await awaitWithAbort(
      chatManager.waitForChatIdle(chat.config.id),
      options.signal,
    );
    if (completed.state.status === "failed" || completed.state.error) {
      throw new DomainError(
        "agent_code_generation_failed",
        completed.state.error?.message ?? "The code generation chat failed",
      );
    }
    const code = await awaitWithAbort(
      executor.readFile(outputFilePath),
      options.signal,
    );
    if (!code?.trim()) {
      throw new DomainError(
        "agent_code_generation_failed",
        "The code generation provider did not create a non-empty source file",
      );
    }

    const normalizedCode = code.trim();
    const diagnostics = validateDeterministicAgentCode(normalizedCode);
    return { code: normalizedCode, diagnostics };
  } finally {
    if (executor && outputFilePath) {
      await removeGenerationFile(executor, options.directory, outputFilePath);
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
