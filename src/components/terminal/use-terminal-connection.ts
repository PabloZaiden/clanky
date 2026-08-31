/**
 * Compositor hook for managing the terminal WebSocket connection and I/O.
 * Delegates to focused sub-hooks for socket state, sending, output, resize, and lifecycle.
 */

import type React from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
export type TerminalSessionKind = "workspace" | "standalone";
import { useTerminalSocketState } from "./use-terminal-socket-state";
import { useTerminalSender } from "./use-terminal-sender";
import { useTerminalOutput } from "./use-terminal-output";
import { useTerminalResize } from "./use-terminal-resize";
import { useTerminalLifecycle } from "./use-terminal-lifecycle";

interface UseTerminalConnectionParams {
  terminalUrl: string | null;
  terminalRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  sessionKind: TerminalSessionKind | null;
  focusTerminal: () => void;
  refresh: () => Promise<void>;
  showErrorToast: (message: string) => void;
  copyTerminalClipboardText: (text: string) => Promise<void>;
  clearSelectedTerminalText: (options?: { clearTerminalSelection?: boolean }) => void;
  loadStandaloneCredentialToken: (options?: { forceRefresh?: boolean; promptOnFailure?: boolean }) => Promise<string | null>;
  setStandaloneCredentialToken: (token: string | null) => void;
  setPendingStandaloneAction: (action: "terminal" | "delete" | null) => void;
  setShowPasswordPrompt: (show: boolean) => void;
}

export function useTerminalConnection({
  terminalUrl,
  terminalRef,
  fitAddonRef,
  sessionKind,
  focusTerminal,
  refresh,
  showErrorToast,
  copyTerminalClipboardText,
  clearSelectedTerminalText,
  loadStandaloneCredentialToken,
  setStandaloneCredentialToken,
  setPendingStandaloneAction,
  setShowPasswordPrompt,
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
    sessionKind,
    terminalSocketRef: socketState.terminalSocketRef,
    terminalReadyRef: socketState.terminalReadyRef,
    pendingOutputRef: socketState.pendingOutputRef,
    pendingOscColorQueryRef: socketState.pendingOscColorQueryRef,
    lastSentResizeRef: socketState.lastSentResizeRef,
    terminalConnectInFlightRef: socketState.terminalConnectInFlightRef,
    standaloneTokenRecoveryAttemptedRef: socketState.standaloneTokenRecoveryAttemptedRef,
    setSocketStatus: socketState.setSocketStatus,
    syncTerminalSize,
    flushPendingOutput,
    writeTerminalOutput,
    refresh,
    showErrorToast,
    copyTerminalClipboardText,
    clearSelectedTerminalText,
    loadStandaloneCredentialToken,
    setStandaloneCredentialToken,
    setPendingStandaloneAction,
    setShowPasswordPrompt,
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
