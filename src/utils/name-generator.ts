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
  const { prompt, backend, sessionId, model, timeoutMs = DEFAULT_TASK_TITLE_TIMEOUT_MS } = options;

  // Validate inputs
  if (!prompt || !prompt.trim()) {
    throw new Error("Prompt cannot be empty");
  }

  if (!backend || !sessionId) {
    throw new Error("Backend and sessionId are required");
  }

  // Truncate prompt for generation (max 1000 chars)
  const truncatedPrompt = prompt.slice(0, 1000);

  // Build the prompt for the backend
  const nameGenerationPrompt: PromptInput = {
    parts: [{
      type: "text",
      text: `Generate a title for a task with the following description. It should be 100 chars or less: ${truncatedPrompt}

Output ONLY the title, nothing else. No quotes, no formatting, no explanation.`
    }],
    model,
  };

  try {
    // Create a promise that rejects after timeout, storing the timer ID
    // so we can clear it when the race completes (prevents timer leak).
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Name generation timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    // Race between generation and timeout
    let response: AgentResponse;
    try {
      response = await Promise.race([
        backend.sendPrompt(sessionId, nameGenerationPrompt),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    const generatedName = response.content.trim();
    if (!generatedName) {
      throw new Error("Title generation returned an empty response");
    }

    const sanitized = sanitizeTaskName(generatedName);
    if (!sanitized) {
      throw new Error("Title generation returned an unusable title");
    }

    return sanitized;
  } catch (error) {
    throw new Error(`Failed to generate task title: ${String(error)}`, { cause: error });
  }
}

export async function generateChatName(options: GenerateChatNameOptions): Promise<string> {
  const { message, backend, sessionId, model, timeoutMs = DEFAULT_CHAT_NAME_TIMEOUT_MS } = options;

  if (!message || !message.trim()) {
    throw new Error("Message cannot be empty");
  }
  if (!backend || !sessionId) {
    throw new Error("Backend and sessionId are required");
  }

  const truncatedMessage = message.slice(0, 1000);
  const nameGenerationPrompt: PromptInput = {
    parts: [{
      type: "text",
      text: `Generate a short name for a chat based on the user's first message. It should be 100 chars or less: ${truncatedMessage}

Output ONLY the chat name, nothing else. No quotes, no formatting, no explanation.`,
    }],
    model,
  };

  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Chat name generation timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    let response: AgentResponse;
    try {
      response = await Promise.race([
        backend.sendPrompt(sessionId, nameGenerationPrompt),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    const generatedName = response.content.trim();
    if (!generatedName) {
      throw new Error("Chat name generation returned an empty response");
    }

    const sanitized = sanitizeChatName(generatedName);
    if (!sanitized) {
      throw new Error("Chat name generation returned an unusable name");
    }

    return sanitized;
  } catch (error) {
    throw new Error(`Failed to generate chat name: ${String(error)}`, { cause: error });
  }
}
