/**
 * Hooks for writing terminal output, including OSC color query processing.
 */

import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { createLogger } from "@pablozaiden/webapp/web";
import {
  MAX_PENDING_OSC_COLOR_QUERY_BYTES,
  MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS,
  MAX_PENDING_TERMINAL_OUTPUT_CHUNKS,
} from "./terminal-constants";
import { parseTerminalOscColorQueries } from "./terminal-osc";

const log = createLogger("terminal-output");

interface UseTerminalOutputParams {
  pendingOutputRef: React.MutableRefObject<string[]>;
  pendingOscColorQueryRef: React.MutableRefObject<string>;
  terminalRef: React.MutableRefObject<Terminal | null>;
  sendTerminalInput: (
    data: string,
    options?: { focusTerminal?: boolean; notifyOnFailure?: boolean },
  ) => Promise<boolean>;
}

export function useTerminalOutput({
  pendingOutputRef,
  pendingOscColorQueryRef,
  terminalRef,
  sendTerminalInput,
}: UseTerminalOutputParams) {
  const writeTerminalOutput = useCallback((chunk: string) => {
    const parsed = parseTerminalOscColorQueries(`${pendingOscColorQueryRef.current}${chunk}`);
    const nextVisibleOutput = parsed.remainder.length > MAX_PENDING_OSC_COLOR_QUERY_BYTES
      ? `${parsed.visibleOutput}${parsed.remainder}`
      : parsed.visibleOutput;
    pendingOscColorQueryRef.current = parsed.remainder.length > MAX_PENDING_OSC_COLOR_QUERY_BYTES
      ? ""
      : parsed.remainder;

    for (const reply of parsed.replies) {
      void sendTerminalInput(reply, { focusTerminal: false, notifyOnFailure: false });
    }

    if (!nextVisibleOutput) {
      return;
    }

    if (!terminalRef.current) {
      const pending = pendingOutputRef.current;
      pending.push(nextVisibleOutput);
      let characters = pending.reduce((total, chunk) => total + chunk.length, 0);
      let truncated = false;
      while (pending.length > MAX_PENDING_TERMINAL_OUTPUT_CHUNKS || characters > MAX_PENDING_TERMINAL_OUTPUT_CHARACTERS) {
        characters -= pending.shift()!.length;
        truncated = true;
      }
      if (truncated) log.warn("Old terminal output was truncated before the renderer became available.");
      return;
    }

    terminalRef.current.write(nextVisibleOutput);
  }, [pendingOscColorQueryRef, pendingOutputRef, sendTerminalInput, terminalRef]);

  const flushPendingOutput = useCallback(() => {
    if (!terminalRef.current || pendingOutputRef.current.length === 0) {
      return;
    }
    for (const chunk of pendingOutputRef.current) {
      terminalRef.current.write(chunk);
    }
    pendingOutputRef.current = [];
  }, [pendingOutputRef, terminalRef]);

  return { writeTerminalOutput, flushPendingOutput };
}
