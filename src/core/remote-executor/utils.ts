/**
 * Internal utility helpers for command execution.
 */

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
): Promise<string> {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
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
