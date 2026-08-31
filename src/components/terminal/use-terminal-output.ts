/**
 * Hooks for writing terminal output, including OSC color query processing.
 */

import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { MAX_PENDING_OSC_COLOR_QUERY_BYTES } from "./terminal-constants";
import { parseTerminalOscColorQueries } from "./terminal-osc";

interface UseTerminalOutputParams {
  pendingOutputRef: React.MutableRefObject<string[]>;
  pendingOscColorQueryRef: React.MutableRefObject<string>;
  terminalRef: React.MutableRefObject<Terminal | null>;
  sendTerminalInput: (
    data: string,
    options?: { focusTerminal?: boolean; notifyOnFailure?: boolean },
  ) => boolean;
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
      pendingOutputRef.current.push(nextVisibleOutput);
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
