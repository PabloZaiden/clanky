/**
 * Compositor hook for managing the terminal WebSocket connection and I/O.
 * Delegates to focused sub-hooks for socket state, sending, output, resize, and lifecycle.
 */

import type React from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useTerminalSocketState } from "./use-terminal-socket-state";
import { useTerminalSender } from "./use-terminal-sender";
import { useTerminalOutput } from "./use-terminal-output";
import { useTerminalResize } from "./use-terminal-resize";
import { useTerminalLifecycle } from "./use-terminal-lifecycle";

interface UseTerminalConnectionParams {
  terminalUrl: string | null;
  terminalRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  focusTerminal: () => void;
  refresh: () => Promise<void>;
  showErrorToast: (message: string) => void;
  copyTerminalClipboardText: (text: string) => Promise<void>;
  clearSelectedTerminalText: (options?: { clearTerminalSelection?: boolean }) => void;
}

export function useTerminalConnection({
  terminalUrl,
  terminalRef,
  fitAddonRef,
  focusTerminal,
  refresh,
  showErrorToast,
  copyTerminalClipboardText,
  clearSelectedTerminalText,
}: UseTerminalConnectionParams) {
  const socketState = useTerminalSocketState();

  const { sendTerminalPayload, sendTerminalInput } = useTerminalSender({
    terminalSocketRef: socketState.terminalSocketRef,
    terminalReadyRef: socketState.terminalReadyRef,
    focusTerminal,
    showErrorToast,
  });

  const { writeTerminalOutput, flushPendingOutput } = useTerminalOutput({
    pendingOutputRef: socketState.pendingOutputRef,
    pendingOscColorQueryRef: socketState.pendingOscColorQueryRef,
    terminalRef,
    sendTerminalInput,
  });

  const { sendTerminalResize, syncTerminalSize } = useTerminalResize({
    lastSentResizeRef: socketState.lastSentResizeRef,
    terminalRef,
    fitAddonRef,
    sendTerminalPayload,
  });

  const { markTerminalReady, connectTerminal, recoverTerminalOnForeground } = useTerminalLifecycle({
    terminalUrl,
    terminalRef,
    terminalSocketRef: socketState.terminalSocketRef,
    terminalReadyRef: socketState.terminalReadyRef,
    pendingOutputRef: socketState.pendingOutputRef,
    pendingOscColorQueryRef: socketState.pendingOscColorQueryRef,
    lastSentResizeRef: socketState.lastSentResizeRef,
    terminalConnectInFlightRef: socketState.terminalConnectInFlightRef,
    setSocketStatus: socketState.setSocketStatus,
    syncTerminalSize,
    flushPendingOutput,
    writeTerminalOutput,
    refresh,
    showErrorToast,
    copyTerminalClipboardText,
    clearSelectedTerminalText,
  });

  return {
    socketStatus: socketState.socketStatus,
    terminalReadyRef: socketState.terminalReadyRef,
    sendTerminalPayload,
    sendTerminalInput,
    sendTerminalResize,
    syncTerminalSize,
    writeTerminalOutput,
    flushPendingOutput,
    markTerminalReady,
    connectTerminal,
    recoverTerminalOnForeground,
  };
}
