/**
 * Internal utility helpers for command execution.
 */

import { CommandOutputLimitError } from "../command-executor";

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function readProcessStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk?: (chunk: string) => void,
  options?: {
    maxBytes?: number;
    streamName?: "stdout" | "stderr";
    onLimit?: (error: CommandOutputLimitError) => void;
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
        const error = new CommandOutputLimitError(
          options.streamName ?? "stdout",
          options.maxBytes,
        );
        options.onLimit?.(error);
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
