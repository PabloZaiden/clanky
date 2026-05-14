import {
  MAX_PENDING_OSC_COLOR_QUERY_BYTES,
  TERMINAL_ANSI_PALETTE,
  TERMINAL_OSC_BELL_TERMINATOR,
  TERMINAL_OSC_C1_TERMINATOR,
  TERMINAL_OSC_QUERY_SEQUENCE_START,
  TERMINAL_OSC_STRING_TERMINATOR,
  TERMINAL_THEME,
} from "./terminal-constants";

function toOscRgb(color: string): string | null {
  const match = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (!match) {
    return null;
  }

  return `rgb:${match[1]}/${match[2]}/${match[3]}`;
}

function buildTerminalOscColorReply(command: "10" | "11"): string | null {
  const color = command === "10" ? TERMINAL_THEME.foreground : TERMINAL_THEME.background;
  const rgb = toOscRgb(color);
  return rgb ? `${TERMINAL_OSC_QUERY_SEQUENCE_START}${command};${rgb}${TERMINAL_OSC_STRING_TERMINATOR}` : null;
}

function formatOscRgbComponent(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function buildOscRgbFromChannels(red: number, green: number, blue: number): string {
  return `rgb:${formatOscRgbComponent(red)}/${formatOscRgbComponent(green)}/${formatOscRgbComponent(blue)}`;
}

function getTerminalPaletteOscRgb(index: number): string | null {
  if (index >= 0 && index < TERMINAL_ANSI_PALETTE.length) {
    return toOscRgb(TERMINAL_ANSI_PALETTE[index] ?? "") ?? null;
  }

  if (index >= 16 && index <= 231) {
    const cubeIndex = index - 16;
    const blue = cubeIndex % 6;
    const green = Math.floor(cubeIndex / 6) % 6;
    const red = Math.floor(cubeIndex / 36);
    const toChannel = (value: number) => value === 0 ? 0 : 55 + value * 40;

    return buildOscRgbFromChannels(toChannel(red), toChannel(green), toChannel(blue));
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return buildOscRgbFromChannels(gray, gray, gray);
  }

  return null;
}

function buildTerminalOscPaletteReply(payload: string): string | null {
  const parts = payload.split(";");
  if (parts.length === 0 || parts.length % 2 !== 0) {
    return null;
  }

  const replyParts: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const paletteIndex = Number(parts[index]);
    const queryValue = parts[index + 1];
    if (!Number.isInteger(paletteIndex) || paletteIndex < 0 || queryValue !== "?") {
      return null;
    }

    const rgb = getTerminalPaletteOscRgb(paletteIndex);
    if (!rgb) {
      return null;
    }

    replyParts.push(String(paletteIndex), rgb);
  }

  return `${TERMINAL_OSC_QUERY_SEQUENCE_START}4;${replyParts.join(";")}${TERMINAL_OSC_STRING_TERMINATOR}`;
}

type TerminalOscColorQuery = {
  command: "4" | "10" | "11";
  index: number;
  length: number;
};

export type ParsedTerminalOscColorQueries = {
  visibleOutput: string;
  replies: string[];
  remainder: string;
};

function findTerminalOscColorQuery(buffer: string, cursor: number): TerminalOscColorQuery | null {
  const query4Index = buffer.indexOf(`${TERMINAL_OSC_QUERY_SEQUENCE_START}4;`, cursor);
  const query10Index = buffer.indexOf(`${TERMINAL_OSC_QUERY_SEQUENCE_START}10;?`, cursor);
  const query11Index = buffer.indexOf(`${TERMINAL_OSC_QUERY_SEQUENCE_START}11;?`, cursor);
  const candidates = [
    query4Index >= 0 ? { command: "4" as const, index: query4Index, length: `${TERMINAL_OSC_QUERY_SEQUENCE_START}4;`.length } : null,
    query10Index >= 0 ? { command: "10" as const, index: query10Index, length: `${TERMINAL_OSC_QUERY_SEQUENCE_START}10;?`.length } : null,
    query11Index >= 0 ? { command: "11" as const, index: query11Index, length: `${TERMINAL_OSC_QUERY_SEQUENCE_START}11;?`.length } : null,
  ].filter((candidate): candidate is TerminalOscColorQuery => candidate !== null);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((earliest, candidate) => candidate.index < earliest.index ? candidate : earliest);
}

function findTerminalOscQueryTerminator(buffer: string, cursor: number): { index: number; length: number } | null {
  const bellIndex = buffer.indexOf(TERMINAL_OSC_BELL_TERMINATOR, cursor);
  const stringIndex = buffer.indexOf(TERMINAL_OSC_STRING_TERMINATOR, cursor);
  const c1Index = buffer.indexOf(TERMINAL_OSC_C1_TERMINATOR, cursor);
  const candidates = [
    bellIndex >= 0 ? { index: bellIndex, length: TERMINAL_OSC_BELL_TERMINATOR.length } : null,
    stringIndex >= 0 ? { index: stringIndex, length: TERMINAL_OSC_STRING_TERMINATOR.length } : null,
    c1Index >= 0 ? { index: c1Index, length: TERMINAL_OSC_C1_TERMINATOR.length } : null,
  ].filter((candidate): candidate is { index: number; length: number } => candidate !== null);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((earliest, candidate) => candidate.index < earliest.index ? candidate : earliest);
}

function getTerminalOscQueryCarryoverLength(buffer: string): number {
  const query = findTerminalOscColorQuery(buffer, 0);
  if (query) {
    const terminator = findTerminalOscQueryTerminator(buffer, query.index + query.length);
    if (!terminator) {
      return buffer.length - query.index;
    }
  }

  const queryPrefixes = [
    `${TERMINAL_OSC_QUERY_SEQUENCE_START}4;`,
    `${TERMINAL_OSC_QUERY_SEQUENCE_START}10;?`,
    `${TERMINAL_OSC_QUERY_SEQUENCE_START}11;?`,
  ];
  const maxCarryoverLength = queryPrefixes.reduce((maxLength, prefix) => Math.max(maxLength, prefix.length), 0) - 1;

  for (let length = Math.min(buffer.length, maxCarryoverLength); length > 0; length -= 1) {
    const suffix = buffer.slice(-length);
    if (queryPrefixes.some((prefix) => prefix.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
}

export function parseTerminalOscColorQueries(buffer: string): ParsedTerminalOscColorQueries {
  let visibleOutput = "";
  const replies: string[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const query = findTerminalOscColorQuery(buffer, cursor);
    if (!query) {
      const carryoverLength = getTerminalOscQueryCarryoverLength(buffer.slice(cursor));
      const flushEnd = buffer.length - carryoverLength;
      visibleOutput += buffer.slice(cursor, flushEnd);
      return {
        visibleOutput,
        replies,
        remainder: buffer.slice(flushEnd),
      };
    }

    visibleOutput += buffer.slice(cursor, query.index);
    const terminator = findTerminalOscQueryTerminator(buffer, query.index + query.length);
    if (!terminator) {
      return {
        visibleOutput,
        replies,
        remainder: buffer.slice(query.index),
      };
    }

    if (query.command === "4") {
      const payload = buffer.slice(query.index + query.length, terminator.index);
      const reply = buildTerminalOscPaletteReply(payload);
      if (reply) {
        replies.push(reply);
      } else {
        visibleOutput += buffer.slice(query.index, terminator.index + terminator.length);
      }
      cursor = terminator.index + terminator.length;
      continue;
    }

    const reply = buildTerminalOscColorReply(query.command);
    if (reply) {
      replies.push(reply);
    }
    cursor = terminator.index + terminator.length;
  }

  return {
    visibleOutput,
    replies,
    remainder: "",
  };
}

// Re-export for consumers that need this constant
export { MAX_PENDING_OSC_COLOR_QUERY_BYTES };
