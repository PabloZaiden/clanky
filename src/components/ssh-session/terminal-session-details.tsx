/**
 * Workspace terminal session detail view.
 * Reuses the shared xterm terminal infrastructure (renderer, keyboard, clipboard,
 * resize, focus mode) from the SSH session module but fetches data through the
 * canonical terminal session API and connects via /api/terminal.
 *
 * No SSH password prompts or standalone credential flow. Connection is
 * immediate for workspace terminal sessions.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { Button } from "../common";
import { useTerminalSession } from "../../hooks/useTerminalSession";
import { useToast } from "@pablozaiden/webapp/web";
import { writeTextToClipboard } from "../../utils";
import {
  TERMINAL_PADDING_BOTTOM_PX,
  TERMINAL_PADDING_TOP_PX,
  TERMINAL_PADDING_X_PX,
} from "./terminal-constants";
import { TerminalInfoSection } from "./terminal-info-section";
import { TouchControlsSection } from "./touch-controls-section";
import { ClipboardFallbackCard } from "./clipboard-fallback-card";
import { useTerminalModifiers } from "./use-terminal-modifiers";
import { useTerminalKeyboard } from "./use-terminal-keyboard";
import { useClipboard } from "./use-clipboard";
import { useSshConnection } from "./use-ssh-connection";
import { useTerminalRenderer } from "./use-terminal-renderer";
import { useFocusMode } from "./use-focus-mode";
import { FocusModeBar } from "./focus-mode-bar";
import { getFocusModeViewportStyle, useVisualViewport } from "./use-visual-viewport";

export interface TerminalSessionDetailsProps {
  terminalSessionId: string;
  onBack?: () => void;
  showBackButton?: boolean;
  copyTextToClipboard?: (text: string) => Promise<void>;
  forcedFocusMode?: boolean;
}

export function TerminalSessionDetails({
  terminalSessionId,
  onBack,
  showBackButton = true,
  copyTextToClipboard: copyClipboardFn = writeTextToClipboard,
  forcedFocusMode = false,
}: TerminalSessionDetailsProps) {
  const toast = useToast();
  const { error: showErrorToast } = toast;
  const { session, loading, error, deleteSession: _deleteSession, refresh } = useTerminalSession(terminalSessionId);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const terminalUrl = useMemo(() => {
    if (!session) {
      return null;
    }
    return `/api/terminal?terminalSessionId=${encodeURIComponent(terminalSessionId)}`;
  }, [session, terminalSessionId]);

  const clipboard = useClipboard({ terminalRef, focusTerminal, showErrorToast, copyTextToClipboard: copyClipboardFn });

  // Workspace terminal sessions do not need standalone credential handling.
  // Provide no-op stubs so the connection hook works unchanged.
  const noopLoadCredential = useCallback(async () => null, []);
  const noopSetCredential = useCallback((_token: string | null) => {}, []);
  const noopSetPendingAction = useCallback((_action: "terminal" | "delete" | null) => {}, []);
  const noopSetShowPassword = useCallback((_show: boolean) => {}, []);

  const connection = useSshConnection({
    terminalUrl,
    terminalRef,
    fitAddonRef,
    sessionKind: "workspace",
    focusTerminal,
    refresh,
    showErrorToast,
    copyTerminalClipboardText: clipboard.copyTerminalClipboardText,
    clearSelectedTerminalText: clipboard.clearSelectedTerminalText,
    loadStandaloneCredentialToken: noopLoadCredential,
    setStandaloneCredentialToken: noopSetCredential,
    setPendingStandaloneAction: noopSetPendingAction,
    setShowPasswordPrompt: noopSetShowPassword,
  });

  const modifiers = useTerminalModifiers(focusTerminal);

  const keyboard = useTerminalKeyboard({
    terminalModifiers: modifiers.terminalModifiers,
    terminalModifiersRef: modifiers.terminalModifiersRef,
    sendTerminalInput: connection.sendTerminalInput,
    resetTerminalModifiers: modifiers.resetTerminalModifiers,
    showErrorToast,
  });

  const { isFocusMode, toggleFocusMode } = useFocusMode(forcedFocusMode);
  const usesViewportAwareFocusMode = isFocusMode && !forcedFocusMode;

  const viewport = useVisualViewport(usesViewportAwareFocusMode);

  const prevViewportHeightRef = useRef<number | null>(null);
  useEffect(() => {
    if (!viewport) {
      prevViewportHeightRef.current = null;
      return;
    }
    if (prevViewportHeightRef.current === viewport.height) {
      return;
    }
    prevViewportHeightRef.current = viewport.height;
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        connection.syncTerminalSize({ fit: true });
      });
      rafCleanup.current = raf2;
    });
    const rafCleanup = { current: 0 as number };
    return () => {
      cancelAnimationFrame(raf1);
      if (rafCleanup.current) {
        cancelAnimationFrame(rafCleanup.current);
      }
    };
  }, [viewport?.height, connection.syncTerminalSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusModeContainerStyle = getFocusModeViewportStyle(usesViewportAwareFocusMode, viewport);

  useTerminalRenderer({
    sessionConfigId: session?.config.id,
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    terminalReadyRef: connection.terminalReadyRef,
    sendTerminalKeystroke: keyboard.sendTerminalKeystroke,
    sendTerminalResize: connection.sendTerminalResize,
    sendTerminalInput: connection.sendTerminalInput,
    syncTerminalSelectionState: clipboard.syncTerminalSelectionState,
    syncTerminalSize: connection.syncTerminalSize,
    flushPendingOutput: connection.flushPendingOutput,
    showErrorToast,
  });

  if (loading && !session) {
    return <div className="p-6 text-gray-500 dark:text-gray-400">Loading terminal session...</div>;
  }

  if (!session) {
    return (
      <div className="p-6">
        {showBackButton && onBack && <Button variant="ghost" onClick={onBack}>← Back</Button>}
        <p className="mt-4 text-red-600 dark:text-red-400">{error || "Terminal session not found."}</p>
      </div>
    );
  }

  const touchControlProps = {
    terminalModifiers: modifiers.terminalModifiers,
    hasSelectedTerminalText: clipboard.hasSelectedTerminalText,
    toggleTerminalModifier: modifiers.toggleTerminalModifier,
    resetTerminalModifiers: modifiers.resetTerminalModifiers,
    copySelectedTerminalText: clipboard.copySelectedTerminalText,
    sendEncodedTerminalKey: keyboard.sendEncodedTerminalKey,
    sendCtrlC: keyboard.sendCtrlC,
  };

  function renderClipboardFallback(compact: boolean) {
    if (clipboard.pendingTerminalClipboardText === null) {
      return null;
    }
    return (
      <ClipboardFallbackCard
        pendingText={clipboard.pendingTerminalClipboardText}
        onDismiss={() => clipboard.setPendingTerminalClipboardText(null)}
        onRetry={clipboard.retryPendingTerminalClipboardCopy}
        compact={compact}
      />
    );
  }

  return (
    <div
      className={
        usesViewportAwareFocusMode
          ? "fixed inset-0 z-50 flex min-h-0 flex-col bg-[#1e1e1e]"
          : isFocusMode
            ? "flex min-h-0 flex-1 flex-col bg-[#1e1e1e]"
            : "flex min-h-0 flex-1 flex-col"
      }
      style={focusModeContainerStyle}
    >
      <div
        className={
          isFocusMode
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "flex-1 min-h-0 flex flex-col gap-2 overflow-hidden p-2 sm:p-3"
        }
      >
        {!isFocusMode && (
          <>
            <TerminalInfoSection session={session} />

            <TouchControlsSection
              {...touchControlProps}
              onEnterFocusMode={toggleFocusMode}
            />

            {renderClipboardFallback(false)}
          </>
        )}

        <div
          className={
            isFocusMode
              ? "min-h-0 flex flex-1 flex-col overflow-hidden bg-[#1e1e1e]"
              : "min-h-0 flex flex-1 flex-col overflow-hidden rounded-sm border border-gray-200 dark:border-gray-700 bg-[#1e1e1e] dark:bg-[#1e1e1e]"
          }
        >
          <div
            ref={terminalContainerRef}
            className="relative box-border min-h-0 h-full flex-1 bg-[#1e1e1e] w-full caret-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400"
            style={{
              caretColor: "transparent",
              padding: `${TERMINAL_PADDING_TOP_PX}px ${TERMINAL_PADDING_X_PX}px ${TERMINAL_PADDING_BOTTOM_PX}px`,
            }}
          />
        </div>
      </div>

      {isFocusMode && renderClipboardFallback(true)}

      {isFocusMode && !forcedFocusMode && (
        <FocusModeBar
          {...touchControlProps}
          onExitFocusMode={toggleFocusMode}
        />
      )}
    </div>
  );
}
