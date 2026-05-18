/**
 * WebSocket lifecycle management: connect, mark ready, and reconnect on foreground.
 */

import { useCallback, useEffect } from "react";
import type { Terminal } from "@xterm/xterm";
import { appWebSocketUrl } from "../../lib/public-path";
import type { SshSessionKind } from "../../hooks/useSshSession";

function isStandaloneCredentialTokenError(message: string): boolean {
  return message.includes("SSH credential token") || message.includes("credential token");
}

interface UseSshLifecycleParams {
  terminalUrl: string | null;
  terminalRef: React.MutableRefObject<Terminal | null>;
  sessionKind: SshSessionKind | null;
  terminalSocketRef: React.MutableRefObject<WebSocket | null>;
  terminalReadyRef: React.MutableRefObject<boolean>;
  pendingOutputRef: React.MutableRefObject<string[]>;
  pendingOscColorQueryRef: React.MutableRefObject<string>;
  lastSentResizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  terminalConnectInFlightRef: React.MutableRefObject<boolean>;
  standaloneTokenRecoveryAttemptedRef: React.MutableRefObject<boolean>;
  setSocketStatus: (status: "connecting" | "open" | "closed") => void;
  syncTerminalSize: (options?: { fit?: boolean }) => void;
  flushPendingOutput: () => void;
  writeTerminalOutput: (chunk: string) => void;
  refresh: () => Promise<void>;
  showErrorToast: (message: string) => void;
  copyTerminalClipboardText: (text: string) => Promise<void>;
  clearSelectedTerminalText: (options?: { clearTerminalSelection?: boolean }) => void;
  loadStandaloneCredentialToken: (options?: { forceRefresh?: boolean; promptOnFailure?: boolean }) => Promise<string | null>;
  setStandaloneCredentialToken: (token: string | null) => void;
  setPendingStandaloneAction: (action: "terminal" | "delete" | null) => void;
  setShowPasswordPrompt: (show: boolean) => void;
}

export function useSshLifecycle({
  terminalUrl,
  terminalRef,
  sessionKind,
  terminalSocketRef,
  terminalReadyRef,
  pendingOutputRef,
  pendingOscColorQueryRef,
  lastSentResizeRef,
  terminalConnectInFlightRef,
  standaloneTokenRecoveryAttemptedRef,
  setSocketStatus,
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
}: UseSshLifecycleParams) {
  const markTerminalReady = useCallback(() => {
    if (terminalReadyRef.current) {
      return;
    }
    terminalReadyRef.current = true;
    standaloneTokenRecoveryAttemptedRef.current = false;
    lastSentResizeRef.current = null;
    setSocketStatus("open");
    syncTerminalSize({ fit: true });
    flushPendingOutput();
    void refresh();
  }, [
    flushPendingOutput,
    lastSentResizeRef,
    refresh,
    setSocketStatus,
    standaloneTokenRecoveryAttemptedRef,
    syncTerminalSize,
    terminalReadyRef,
  ]);

  const connectTerminal = useCallback(async (
    options?: { refreshStandaloneCredential?: boolean; standaloneCredentialToken?: string },
  ) => {
    if (!terminalUrl) {
      return;
    }
    if (terminalConnectInFlightRef.current) {
      return;
    }
    terminalConnectInFlightRef.current = true;
    try {
      let standaloneAuthToken = options?.standaloneCredentialToken ?? null;
      if (sessionKind === "standalone") {
        if (!standaloneAuthToken) {
          standaloneAuthToken = await loadStandaloneCredentialToken({
            forceRefresh: options?.refreshStandaloneCredential ?? false,
          });
        }
        if (!standaloneAuthToken) {
          return;
        }
      }
      terminalSocketRef.current?.close();
      terminalReadyRef.current = false;
      pendingOutputRef.current = [];
      pendingOscColorQueryRef.current = "";
      lastSentResizeRef.current = null;
      clearSelectedTerminalText();
      setSocketStatus("connecting");

      const ws = new WebSocket(appWebSocketUrl(terminalUrl));
      terminalSocketRef.current = ws;

      ws.onopen = () => {
        if (standaloneAuthToken) {
          ws.send(JSON.stringify({
            type: "terminal.auth",
            credentialToken: standaloneAuthToken,
          }));
        }
      };
      ws.onmessage = (event) => {
        if (terminalSocketRef.current !== ws) {
          return;
        }
        const data = JSON.parse(event.data as string) as {
          type: string;
          data?: string;
          message?: string;
          text?: string;
        };
        if (data.type === "terminal.connected") {
          markTerminalReady();
        }
        if (data.type === "terminal.clipboard" && typeof data.text === "string") {
          void copyTerminalClipboardText(data.text);
        }
        if (data.type === "terminal.output" && data.data) {
          if (!terminalReadyRef.current) {
            markTerminalReady();
          }
          writeTerminalOutput(data.data);
        }
        if (data.type === "terminal.error" && data.message) {
          terminalRef.current?.writeln(`\r\n${data.message}`);
          if (sessionKind === "standalone" && isStandaloneCredentialTokenError(data.message)) {
            setStandaloneCredentialToken(null);
            if (standaloneTokenRecoveryAttemptedRef.current) {
              setPendingStandaloneAction("terminal");
              setShowPasswordPrompt(true);
              showErrorToast("Failed to refresh the SSH session automatically. Re-enter the SSH password to continue.");
              return;
            }
            standaloneTokenRecoveryAttemptedRef.current = true;
            terminalReadyRef.current = false;
            lastSentResizeRef.current = null;
            pendingOscColorQueryRef.current = "";
            setSocketStatus("closed");
            if (terminalSocketRef.current === ws) {
              terminalSocketRef.current = null;
            }
            ws.close();
            void connectTerminal({ refreshStandaloneCredential: true });
            return;
          }
          terminalReadyRef.current = false;
          lastSentResizeRef.current = null;
          pendingOscColorQueryRef.current = "";
          clearSelectedTerminalText();
          setSocketStatus("closed");
          showErrorToast(data.message);
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        }
        if (data.type === "terminal.closed") {
          terminalReadyRef.current = false;
          lastSentResizeRef.current = null;
          pendingOscColorQueryRef.current = "";
          clearSelectedTerminalText();
          setSocketStatus("closed");
        }
      };
      ws.onclose = () => {
        if (terminalSocketRef.current !== ws) {
          return;
        }
        terminalSocketRef.current = null;
        terminalReadyRef.current = false;
        lastSentResizeRef.current = null;
        pendingOscColorQueryRef.current = "";
        clearSelectedTerminalText();
        setSocketStatus("closed");
      };
      ws.onerror = () => {
        if (terminalSocketRef.current !== ws) {
          return;
        }
        terminalReadyRef.current = false;
        lastSentResizeRef.current = null;
        pendingOscColorQueryRef.current = "";
        clearSelectedTerminalText();
        setSocketStatus("closed");
      };
    } finally {
      terminalConnectInFlightRef.current = false;
    }
  }, [
    clearSelectedTerminalText,
    copyTerminalClipboardText,
    lastSentResizeRef,
    loadStandaloneCredentialToken,
    markTerminalReady,
    pendingOscColorQueryRef,
    pendingOutputRef,
    sessionKind,
    setShowPasswordPrompt,
    setSocketStatus,
    setStandaloneCredentialToken,
    setPendingStandaloneAction,
    showErrorToast,
    standaloneTokenRecoveryAttemptedRef,
    terminalConnectInFlightRef,
    terminalReadyRef,
    terminalRef,
    terminalSocketRef,
    terminalUrl,
    writeTerminalOutput,
  ]);

  const recoverTerminalOnForeground = useCallback(() => {
    if (!terminalUrl) {
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    const readyState = terminalSocketRef.current?.readyState;
    if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
      return;
    }
    void connectTerminal({ refreshStandaloneCredential: sessionKind === "standalone" });
  }, [connectTerminal, sessionKind, terminalSocketRef, terminalUrl]);

  useEffect(() => {
    if (!terminalUrl) {
      return;
    }
    void connectTerminal();
    return () => {
      terminalReadyRef.current = false;
      terminalSocketRef.current?.close();
      terminalSocketRef.current = null;
      clearSelectedTerminalText();
    };
  }, [clearSelectedTerminalText, connectTerminal, terminalReadyRef, terminalSocketRef, terminalUrl]);

  useEffect(() => {
    if (!terminalUrl || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const handleWindowFocus = () => {
      recoverTerminalOnForeground();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recoverTerminalOnForeground();
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [recoverTerminalOnForeground, terminalUrl]);

  return { markTerminalReady, connectTerminal, recoverTerminalOnForeground };
}
