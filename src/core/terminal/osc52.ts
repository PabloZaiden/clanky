/**
 * OSC 52 clipboard sequence parsing utilities.
 */

import { OSC_52_SEQUENCE_START, OSC_SEQUENCE_BELL, OSC_SEQUENCE_STRING_TERMINATOR } from "./constants";

export interface ClipboardSequenceResult {
  visibleOutput: string;
  clipboardCopies: string[];
  remainder: string;
}

function getOsc52CarryoverLength(buffer: string): number {
  const maxCarryoverLength = Math.min(buffer.length, OSC_52_SEQUENCE_START.length - 1);
  for (let length = maxCarryoverLength; length > 0; length--) {
    if (OSC_52_SEQUENCE_START.startsWith(buffer.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function findOsc52Terminator(buffer: string, searchStart: number): { index: number; length: number } | null {
  const bellIndex = buffer.indexOf(OSC_SEQUENCE_BELL, searchStart);
  const stringTerminatorIndex = buffer.indexOf(OSC_SEQUENCE_STRING_TERMINATOR, searchStart);
  if (bellIndex === -1 && stringTerminatorIndex === -1) {
    return null;
  }
  if (bellIndex !== -1 && (stringTerminatorIndex === -1 || bellIndex < stringTerminatorIndex)) {
    return {
      index: bellIndex,
      length: OSC_SEQUENCE_BELL.length,
    };
  }
  return {
    index: stringTerminatorIndex,
    length: OSC_SEQUENCE_STRING_TERMINATOR.length,
  };
}

function decodeClipboardPayload(payload: string): string | null {
  const separatorIndex = payload.indexOf(";");
  if (separatorIndex < 0) {
    return null;
  }
  const encodedText = payload.slice(separatorIndex + 1);
  if (encodedText === "?") {
    return null;
  }
  return Buffer.from(encodedText, "base64").toString("utf8");
}

export function extractClipboardSequences(buffer: string): ClipboardSequenceResult {
  let cursor = 0;
  let visibleOutput = "";
  const clipboardCopies: string[] = [];

  while (cursor < buffer.length) {
    const sequenceStart = buffer.indexOf(OSC_52_SEQUENCE_START, cursor);
    if (sequenceStart < 0) {
      const carryoverLength = getOsc52CarryoverLength(buffer.slice(cursor));
      const flushEnd = buffer.length - carryoverLength;
      visibleOutput += buffer.slice(cursor, flushEnd);
      return {
        visibleOutput,
        clipboardCopies,
        remainder: buffer.slice(flushEnd),
      };
    }

    visibleOutput += buffer.slice(cursor, sequenceStart);
    const terminator = findOsc52Terminator(buffer, sequenceStart + OSC_52_SEQUENCE_START.length);
    if (!terminator) {
      return {
        visibleOutput,
        clipboardCopies,
        remainder: buffer.slice(sequenceStart),
      };
    }

    const payload = buffer.slice(sequenceStart + OSC_52_SEQUENCE_START.length, terminator.index);
    const clipboardText = decodeClipboardPayload(payload);
    if (clipboardText !== null) {
      clipboardCopies.push(clipboardText);
    }
    cursor = terminator.index + terminator.length;
  }

  return {
    visibleOutput,
    clipboardCopies,
    remainder: "",
  };
}
