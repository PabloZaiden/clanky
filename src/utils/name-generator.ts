/**
 * Task title generation utility.
 * Generates AI-assisted task titles from prompts using the configured agent backend.
 */

import type { PromptInput, AgentResponse } from "../backends/types";
import type { ModelConfig } from "@/shared";

export const DEFAULT_TASK_TITLE_TIMEOUT_MS = 30_000;
export const DEFAULT_CHAT_NAME_TIMEOUT_MS = 30_000;

/**
 * Backend interface for name generation.
 * Matches the interface used by TaskEngine.
 */
export interface BackendInterface {
  sendPrompt(sessionId: string, prompt: PromptInput): Promise<AgentResponse>;
}

/**
 * Options for generating a task name.
 */
export interface GenerateTaskNameOptions {
  /** The prompt describing the task */
  prompt: string;
  /** Backend instance to use for generation */
  backend: BackendInterface;
  /** Session ID to use for the generation */
  sessionId: string;
  /** Optional model override for helper generation */
  model?: ModelConfig;
  /** Timeout in milliseconds (default: 30_000ms / 30s, see DEFAULT_TASK_TITLE_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Cancel the temporary backend session if generation times out */
  cancelSession?: () => Promise<void>;
}

export interface GenerateChatNameOptions {
  /** The first user message in the chat */
  message: string;
  /** Backend instance to use for generation */
  backend: BackendInterface;
  /** Session ID to use for the generation */
  sessionId: string;
  /** Optional model override for helper generation */
  model?: ModelConfig;
  /** Timeout in milliseconds (default: 30_000ms / 30s, see DEFAULT_CHAT_NAME_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Cancel the temporary backend session if generation times out */
  cancelSession?: () => Promise<void>;
}

/**
 * Sanitize a generated task name.
 * - Removes markdown formatting (backticks, asterisks, etc.)
 * - Removes control characters
 * - Collapses consecutive whitespace to single spaces
 * - Trims leading/trailing whitespace
 * - Truncates to max 100 characters
 * - Preserves spaces and natural casing for readability
 */
export function sanitizeTaskName(name: string): string {
  return name
    .replace(/[`*~#]/g, "")            // Remove markdown formatting
    .replace(/[\x00-\x1F\x7F]/g, "")   // Remove control characters
    .replace(/\s+/g, " ")              // Collapse consecutive whitespace to single space
    .trim()                             // Trim whitespace
    .slice(0, 100);                     // Limit length to 100 chars
}

export const sanitizeChatName = sanitizeTaskName;

class NameGenerationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameGenerationTimeoutError";
  }
}

interface GenerateNameOperationOptions {
  source: string;
  sourceError: string;
  backend: BackendInterface;
  sessionId: string;
  model?: ModelConfig;
  timeoutMs: number;
  buildPrompt: (source: string, model?: ModelConfig) => PromptInput;
  timeoutMessage: string;
  emptyResponseMessage: string;
  unusableResponseMessage: string;
  errorPrefix: string;
  sanitize: (name: string) => string;
  cancelSession?: () => Promise<void>;
}

async function sendPromptWithTimeout(
  options: Pick<
    GenerateNameOperationOptions,
    "backend" | "sessionId" | "timeoutMs" | "timeoutMessage" | "cancelSession"
  > & { prompt: PromptInput },
): Promise<AgentResponse> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const responsePromise = Promise.resolve().then(() =>
    options.backend.sendPrompt(options.sessionId, options.prompt)
  );
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new NameGenerationTimeoutError(options.timeoutMessage)),
      options.timeoutMs,
    );
  });

  try {
    return await Promise.race([responsePromise, timeoutPromise]);
  } catch (error) {
    if (!(error instanceof NameGenerationTimeoutError) || !options.cancelSession) {
      throw error;
    }

    try {
      await options.cancelSession();
    } catch (cancelError) {
      throw new Error(
        `${error.message}; failed to cancel temporary backend session: ${String(cancelError)}`,
        { cause: cancelError },
      );
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function generateName(options: GenerateNameOperationOptions): Promise<string> {
  if (!options.source || !options.source.trim()) {
    throw new Error(options.sourceError);
  }

  if (!options.backend || !options.sessionId) {
    throw new Error("Backend and sessionId are required");
  }

  try {
    const response = await sendPromptWithTimeout({
      backend: options.backend,
      sessionId: options.sessionId,
      prompt: options.buildPrompt(options.source.slice(0, 1000), options.model),
      timeoutMs: options.timeoutMs,
      timeoutMessage: options.timeoutMessage,
      cancelSession: options.cancelSession,
    });
    const generatedName = response.content.trim();
    if (!generatedName) {
      throw new Error(options.emptyResponseMessage);
    }

    const sanitized = options.sanitize(generatedName);
    if (!sanitized) {
      throw new Error(options.unusableResponseMessage);
    }

    return sanitized;
  } catch (error) {
    throw new Error(`${options.errorPrefix}: ${String(error)}`, { cause: error });
  }
}

/**
 * Generate a task title from a prompt using the configured agent backend.
 *
 * This function sends a prompt to the backend asking it to generate a short,
 * descriptive title for a coding task. The title is sanitized and validated
 * before being returned.
 *
 * @param options - Options for name generation
 * @returns A sanitized task title (max 100 chars, preserves spaces and casing)
 * @throws Error if prompt is empty, the backend call fails, or the response is unusable
 */
export async function generateTaskName(options: GenerateTaskNameOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TITLE_TIMEOUT_MS;
  return generateName({
    source: options.prompt,
    sourceError: "Prompt cannot be empty",
    backend: options.backend,
    sessionId: options.sessionId,
    model: options.model,
    timeoutMs,
    buildPrompt: (truncatedPrompt, model) => ({
      parts: [{
        type: "text",
        text: `Generate a title for a task with the following description. It should be 100 chars or less: ${truncatedPrompt}

Output ONLY the title, nothing else. No quotes, no formatting, no explanation.`,
      }],
      model,
    }),
    timeoutMessage: `Name generation timed out after ${timeoutMs}ms`,
    emptyResponseMessage: "Title generation returned an empty response",
    unusableResponseMessage: "Title generation returned an unusable title",
    errorPrefix: "Failed to generate task title",
    sanitize: sanitizeTaskName,
    cancelSession: options.cancelSession,
  });
}

export async function generateChatName(options: GenerateChatNameOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_NAME_TIMEOUT_MS;
  return generateName({
    source: options.message,
    sourceError: "Message cannot be empty",
    backend: options.backend,
    sessionId: options.sessionId,
    model: options.model,
    timeoutMs,
    buildPrompt: (truncatedMessage, model) => ({
      parts: [{
        type: "text",
        text: `Generate a short name for a chat based on the user's first message. It should be 100 chars or less: ${truncatedMessage}

Output ONLY the chat name, nothing else. No quotes, no formatting, no explanation.`,
      }],
      model,
    }),
    timeoutMessage: `Chat name generation timed out after ${timeoutMs}ms`,
    emptyResponseMessage: "Chat name generation returned an empty response",
    unusableResponseMessage: "Chat name generation returned an unusable name",
    errorPrefix: "Failed to generate chat name",
    sanitize: sanitizeChatName,
    cancelSession: options.cancelSession,
  });
}
