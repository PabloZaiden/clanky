/**
 * Single-range streaming for native DAV clients; no whole-file buffering.
 */

import { DavError } from "./protocol";

export function byteRange(value: string, size: number): { start: number; end: number } {
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) {
    throw new DavError(416, "A satisfiable single byte range is required.");
  }
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first))
    || (last !== undefined && !Number.isSafeInteger(last))) {
    throw new DavError(416, "The byte range is too large.");
  }
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || start > end) throw new DavError(416, "The byte range is outside the file.");
  return { start, end };
}

export function rangeStream(
  source: ReadableStream<Uint8Array>, range: { start: number; end: number },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { reader.releaseLock(); controller.close(); return; }
          const begin = Math.max(0, range.start - offset);
          const end = Math.min(value.byteLength, range.end + 1 - offset);
          offset += value.byteLength;
          if (begin < end) controller.enqueue(value.subarray(begin, end));
          if (offset > range.end) {
            await reader.cancel();
            reader.releaseLock();
            controller.close();
          }
          if (begin < end || offset > range.end) return;
        }
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  });
}
