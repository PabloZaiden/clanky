/**
 * Binary range adapter using existing host exec contracts, including old Mesh
 * workers. Each bounded window seeks on the host; no wire-generation changes.
 */

import type { CommandExecutor, CommandResult, FileStreamOptions } from "./command-executor";
import { DomainError } from "../domain/domain-error";

const WINDOW_BYTES = 1_024 * 1_024;
const BLOCK_BYTES = 65_536;

function failure(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("file_system_operation_failed", message, { details });
}

async function readWindow({ executor, path, start, length, signal }: {
  executor: CommandExecutor; path: string; start: number; length: number; signal: AbortSignal;
}): Promise<Uint8Array> {
  signal.throwIfAborted();
  const options = { signal, timeout: 120_000, maxOutputBytes: 2 * WINDOW_BYTES, longRunning: true };
  const offset = start % BLOCK_BYTES;
  const result: CommandResult = executor.pathStyle === "windows"
    ? await executor.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; "
        + "$f=[IO.File]::Open($env:CLANKY_RANGE_PATH,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); "
        + "try { $f.Seek([int64]$env:CLANKY_RANGE_START,'Begin') | Out-Null; "
        + "$b=New-Object byte[] ([int]$env:CLANKY_RANGE_LENGTH); $i=0; "
        + "while($i -lt $b.Length) { $n=$f.Read($b,$i,$b.Length-$i); if($n -eq 0) { throw 'Short range read' }; $i+=$n }; "
        + "[Console]::Write([Convert]::ToBase64String($b)) } finally { $f.Dispose() }",
      ], { ...options, env: {
        CLANKY_RANGE_PATH: path, CLANKY_RANGE_START: String(start), CLANKY_RANGE_LENGTH: String(length),
      } })
    : await executor.exec("sh", ["-c",
        // A fixed-width status trailer preserves dd failure across the POSIX pipe.
        '{ dd if="$1" bs=65536 skip="$2" count="$3"; code=$?; printf "%03d" "$code"; } | base64',
        "clanky-range", path, String(Math.floor(start / BLOCK_BYTES)),
        String(Math.ceil((offset + length) / BLOCK_BYTES)),
      ], options);
  signal.throwIfAborted();
  if (!result.success) throw failure("Host range read failed.", { exitCode: result.exitCode });
  const encoded = result.stdout.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw failure("Host returned invalid range data.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) throw failure("Host returned invalid range data.");
  if (executor.pathStyle === "windows") {
    if (decoded.length !== length) throw failure("Host range read was truncated.");
    return decoded;
  }
  if (decoded.length < 3 || decoded.subarray(-3).toString("ascii") !== "000") {
    throw failure("Host range read failed.");
  }
  const bytes = decoded.subarray(offset, decoded.length - 3);
  if (bytes.length < length) throw failure("Host range read was truncated.");
  return bytes.subarray(0, length);
}

export function streamFileRange(
  executor: CommandExecutor, path: string, options: FileStreamOptions & { range: NonNullable<FileStreamOptions["range"]> },
): ReadableStream<Uint8Array> {
  const range = options.range;
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError("file_system_invalid_path", "Invalid file byte interval.");
  }
  options.signal?.throwIfAborted();
  const abort = new AbortController();
  const onAbort = () => { abort.abort(options.signal?.reason); cleanup(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
  let position = range.start;
  let cancelled = false;
  let active: Promise<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const length = Math.min(WINDOW_BYTES, range.end - position + 1);
        active = readWindow({ executor, path, start: position, length, signal: abort.signal });
        const bytes = await active;
        if (cancelled) return;
        position += bytes.length;
        controller.enqueue(bytes);
        if (position > range.end) { cleanup(); controller.close(); }
      } catch (error) {
        cleanup();
        if (!cancelled) controller.error(error);
      } finally {
        active = undefined;
      }
    },
    async cancel(reason) {
      cancelled = true;
      abort.abort(reason);
      cleanup();
      // Suppress confirmed cancellation only; failed remote cleanup must surface.
      await active?.catch((error: unknown) => {
        if (error === abort.signal.reason) return;
        if (error instanceof DomainError && error.code === "mesh_execution_aborted"
          && (error.cause === undefined || error.cause === abort.signal.reason)) return;
        throw error;
      });
    },
  }, { highWaterMark: 0 });
}
