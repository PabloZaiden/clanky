/**
 * Compositor hook for managing the SSH terminal WebSocket connection and I/O.
 * Delegates to focused sub-hooks for socket state, sending, output, resize, and lifecycle.
 */

import type React from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SshSessionKind } from "../../hooks/useSshSession";
import { useSshSocketState } from "./use-ssh-socket-state";
import { useSshSender } from "./use-ssh-sender";
import { useTerminalOutput } from "./use-terminal-output";
import { useTerminalResize } from "./use-terminal-resize";
import { useSshLifecycle } from "./use-ssh-lifecycle";

interface UseSshConnectionParams {
  terminalUrl: string | null;
  terminalRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  sessionKind: SshSessionKind | null;
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

export function useSshConnection({
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
}: UseSshConnectionParams) {
  const socketState = useSshSocketState();

  const { sendTerminalPayload, sendTerminalInput } = useSshSender({
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

  const { markTerminalReady, connectTerminal, recoverTerminalOnForeground } = useSshLifecycle({
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
