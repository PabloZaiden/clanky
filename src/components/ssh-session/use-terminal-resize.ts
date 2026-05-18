/**
 * Hooks for sending terminal resize events and syncing the terminal dimensions.
 */

import { useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SendTerminalPayloadFn } from "./use-ssh-sender";

interface UseTerminalResizeParams {
  lastSentResizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  terminalRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  sendTerminalPayload: SendTerminalPayloadFn;
}

export function useTerminalResize({
  lastSentResizeRef,
  terminalRef,
  fitAddonRef,
  sendTerminalPayload,
}: UseTerminalResizeParams) {
  const sendTerminalResize = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) {
      return;
    }
    const previousSize = lastSentResizeRef.current;
    if (previousSize && previousSize.cols === cols && previousSize.rows === rows) {
      return;
    }
    const didSend = sendTerminalPayload(
      { type: "terminal.resize", cols, rows },
      { focusTerminal: false, notifyOnFailure: false },
    );
    if (didSend) {
      lastSentResizeRef.current = { cols, rows };
    }
  }, [lastSentResizeRef, sendTerminalPayload]);

  const syncTerminalSize = useCallback((options?: { fit?: boolean }) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (options?.fit) {
      fitAddonRef.current?.fit();
    }
    sendTerminalResize(terminal.cols, terminal.rows);
  }, [fitAddonRef, sendTerminalResize, terminalRef]);

  return { sendTerminalResize, syncTerminalSize };
}
