/**
 * Internal utility helpers for command execution.
 */

import { CommandOutputLimitError } from "../command-executor";

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildEnvAssignments(env?: Record<string, string>): string[] {
  if (!env) {
    return [];
  }

  const entries = Object.entries(env);
  const assignments: string[] = [];
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    assignments.push(`${key}=${quoteShell(value)}`);
  }
  return assignments;
}

export function buildExportAssignments(env?: Record<string, string>): string[] {
  return buildEnvAssignments(env).map((assignment) => `export ${assignment};`);
}

export async function readProcessStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk?: (chunk: string) => void,
  options?: {
    maxBytes?: number;
    streamName?: "stdout" | "stderr";
    onLimit?: () => void;
  },
): Promise<string> {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytesRead += value.byteLength;
      if (options?.maxBytes !== undefined && bytesRead > options.maxBytes) {
        options.onLimit?.();
        const error = new CommandOutputLimitError(
          options.streamName ?? "stdout",
          options.maxBytes,
        );
        try {
          await reader.cancel(error);
        } catch {
          // Preserve the typed output-limit error when stream cancellation races process exit.
        }
        throw error;
      }
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      onChunk?.(chunk);
    }

    const finalChunk = decoder.decode();
    if (finalChunk) {
      text += finalChunk;
      onChunk?.(finalChunk);
    }
  } finally {
    reader.releaseLock();
  }

  return text;
}
