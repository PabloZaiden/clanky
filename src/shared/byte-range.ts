/**
 * Validated inclusive byte intervals for single-range HTTP reads.
 */

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first))
    || (last !== undefined && !Number.isSafeInteger(last))) return null;
  const start = first ?? Math.max(0, size - (last ?? 0));
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  return start >= size || start > end ? null : { start, end };
}
