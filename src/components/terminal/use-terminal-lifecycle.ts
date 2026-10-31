/**
 * Application terminal lifecycle and protocol handling over WebAppDuplex.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { createLogger, type WebAppDuplex } from "@pablozaiden/webapp/web";
import { z } from "zod";
import { TerminalChannel } from "./terminal-channel";

const log = createLogger("terminal-lifecycle");
const TerminalMessageSchema = z.object({
  type: z.string(),
  code: z.union([z.string(), z.number(), z.null()]).optional(),
  data: z.string().optional(),
  message: z.string().optional(),
  text: z.string().optional(),
});

interface TerminalMessageContext {
  isCurrent: () => boolean;
  fail: (error: unknown) => void;
}

interface UseTerminalLifecycleParams {
  terminalUrl: string | null;
  terminalRef: React.MutableRefObject<Terminal | null>;
  terminalSocketRef: React.MutableRefObject<WebAppDuplex | null>;
  terminalReadyRef: React.MutableRefObject<boolean>;
  pendingOutputRef: React.MutableRefObject<string[]>;
  pendingOscColorQueryRef: React.MutableRefObject<string>;
  lastSentResizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  terminalConnectInFlightRef: React.MutableRefObject<boolean>;
  setSocketStatus: (status: "connecting" | "open" | "closed") => void;
  syncTerminalSize: (options?: { fit?: boolean }) => void;
  flushPendingOutput: () => void;
  writeTerminalOutput: (chunk: string) => void;
  refresh: () => Promise<void>;
  showErrorToast: (message: string) => void;
  copyTerminalClipboardText: (text: string) => Promise<void>;
  clearSelectedTerminalText: (options?: { clearTerminalSelection?: boolean }) => void;
}

export function useTerminalLifecycle({
  terminalUrl,
  terminalRef,
  terminalSocketRef,
  terminalReadyRef,
  pendingOutputRef,
  pendingOscColorQueryRef,
  lastSentResizeRef,
  terminalConnectInFlightRef,
  setSocketStatus,
  syncTerminalSize,
  flushPendingOutput,
  writeTerminalOutput,
  refresh,
  showErrorToast,
  copyTerminalClipboardText,
  clearSelectedTerminalText,
}: UseTerminalLifecycleParams) {
  const currentRef = useRef<TerminalChannel | null>(null);
  const closingRef = useRef<Promise<void>>(Promise.resolve());
  const resetTerminal = useCallback(() => {
    terminalSocketRef.current = null;
    terminalReadyRef.current = false;
    lastSentResizeRef.current = null;
    pendingOscColorQueryRef.current = "";
    clearSelectedTerminalText();
    setSocketStatus("closed");
  }, [clearSelectedTerminalText, lastSentResizeRef, pendingOscColorQueryRef, setSocketStatus, terminalReadyRef, terminalSocketRef]);
  const closeTerminal = useCallback((): Promise<void> => {
    const previous = currentRef.current;
    currentRef.current = null;
    terminalConnectInFlightRef.current = false;
    resetTerminal();
    if (previous) {
      closingRef.current = Promise.all([closingRef.current, previous.stop()]).then(() => undefined);
    }
    return closingRef.current;
  }, [resetTerminal, terminalConnectInFlightRef]);
  const reportCleanupFailure = useCallback((error: unknown) => {
    log.error("Terminal shutdown failed; replacement connection is blocked", { error: String(error) });
  }, []);
  const markTerminalReady = useCallback(() => {
    if (terminalReadyRef.current) {
      return;
    }
    terminalReadyRef.current = true;
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
    syncTerminalSize,
    terminalReadyRef,
  ]);

  const handleMessage = useCallback((raw: string | ArrayBuffer, context: TerminalMessageContext): void => {
    if (!context.isCurrent()) return;
    try {
      if (typeof raw !== "string") throw new Error("The terminal received an unsupported binary message.");
      const data = TerminalMessageSchema.parse(JSON.parse(raw));
      if (data.type === "terminal.connected") markTerminalReady();
      if (data.type === "terminal.clipboard" && typeof data.text === "string") {
        void copyTerminalClipboardText(data.text).catch((error: unknown) => {
          log.error("Terminal clipboard copy failed", { error: String(error) });
          showErrorToast("Terminal text could not be copied.");
        });
      }
      if (data.type === "terminal.output" && data.data) {
        markTerminalReady();
        writeTerminalOutput(data.data);
      }
      if (data.type === "terminal.closed") {
        void closeTerminal().catch(reportCleanupFailure);
      }
      if (data.type === "terminal.error" && data.message) {
        terminalRef.current?.writeln(`\r\n${data.message}`);
        context.fail(new Error(data.message));
      }
    } catch (error) {
      context.fail(error);
    }
  }, [
    closeTerminal, copyTerminalClipboardText, markTerminalReady, reportCleanupFailure,
    showErrorToast, terminalRef, writeTerminalOutput,
  ]);

  const connectTerminal = useCallback(async () => {
    if (!terminalUrl || terminalConnectInFlightRef.current) return;
    const previous = closeTerminal();
    terminalConnectInFlightRef.current = true;
    let reported = false;
    const fail = (error: unknown): void => {
      if (currentRef.current !== owner || reported) return;
      reported = true;
      resetTerminal();
      showErrorToast(`Terminal connection failed: ${String(error)}`);
      void closeTerminal().catch(reportCleanupFailure);
    };
    const messages: TerminalMessageContext = {
      isCurrent: () => currentRef.current === owner,
      fail,
    };
    const owner = new TerminalChannel({
      path: terminalUrl,
      onChannel: (channel) => { if (currentRef.current === owner) terminalSocketRef.current = channel; },
      onMessage: (raw) => handleMessage(raw, messages),
      onClose: () => {
        if (currentRef.current === owner) void closeTerminal().catch(reportCleanupFailure);
      },
      onError: fail,
    });
    currentRef.current = owner;
    try {
      await previous;
      if (currentRef.current !== owner) return;
      terminalReadyRef.current = false;
      pendingOutputRef.current = [];
      pendingOscColorQueryRef.current = "";
      lastSentResizeRef.current = null;
      clearSelectedTerminalText();
      setSocketStatus("connecting");

      await owner.start();
    } catch (error) {
      fail(error);
    } finally {
      if (currentRef.current === owner) terminalConnectInFlightRef.current = false;
    }
  }, [
    clearSelectedTerminalText,
    closeTerminal,
    handleMessage,
    lastSentResizeRef,
    pendingOscColorQueryRef,
    pendingOutputRef,
    reportCleanupFailure,
    resetTerminal,
    setSocketStatus,
    showErrorToast,
    terminalConnectInFlightRef,
    terminalReadyRef,
    terminalSocketRef,
    terminalUrl,
  ]);

  const recoverTerminalOnForeground = useCallback(() => {
    if (!terminalUrl) {
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    if (terminalSocketRef.current || terminalConnectInFlightRef.current) {
      return;
    }
    void connectTerminal();
  }, [connectTerminal, terminalConnectInFlightRef, terminalSocketRef, terminalUrl]);

  useEffect(() => {
    if (!terminalUrl) {
      return;
    }
    void connectTerminal();
    return () => {
      // React cleanup is synchronous; retain shutdown and await it before replacement.
      void closeTerminal().catch(reportCleanupFailure);
    };
  }, [closeTerminal, connectTerminal, reportCleanupFailure, terminalUrl]);

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
