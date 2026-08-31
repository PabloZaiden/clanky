/**
 * Dedicated standalone SSH server session terminal view.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { Button } from "../common";
import { useSshServerSession } from "../../hooks";
import { useToast } from "@pablozaiden/webapp/web";
import { isPersistentTerminalSession, writeTextToClipboard } from "../../utils";
import {
  TERMINAL_PADDING_BOTTOM_PX,
  TERMINAL_PADDING_TOP_PX,
  TERMINAL_PADDING_X_PX,
} from "../terminal/terminal-constants";
import { storeSshServerPassword, getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import { SshServerSessionInfoSection } from "./ssh-server-session-info-section";
import { TouchControlsSection } from "../terminal/touch-controls-section";
import { ClipboardFallbackCard } from "../terminal/clipboard-fallback-card";
import { StandalonePasswordModal } from "./standalone-password-modal";
import { useTerminalModifiers } from "../terminal/use-terminal-modifiers";
import { useTerminalKeyboard } from "../terminal/use-terminal-keyboard";
import { useClipboard } from "../terminal/use-clipboard";
import { useStandaloneSession } from "./use-standalone-session";
import { useTerminalConnection } from "../terminal/use-terminal-connection";
import { useTerminalRenderer } from "../terminal/use-terminal-renderer";
import { useFocusMode } from "../terminal/use-focus-mode";
import { FocusModeBar } from "../terminal/focus-mode-bar";
import { getFocusModeViewportStyle, useVisualViewport } from "../terminal/use-visual-viewport";

export interface SshServerSessionDetailsProps {
  sshServerSessionId: string;
  onBack?: () => void;
  showBackButton?: boolean;
  copyTextToClipboard?: (text: string) => Promise<void>;
  forcedFocusMode?: boolean;
}

export function SshServerSessionDetails({
  sshServerSessionId,
  onBack,
  showBackButton = true,
  copyTextToClipboard = writeTextToClipboard,
  forcedFocusMode = false,
}: SshServerSessionDetailsProps) {
  const toast = useToast();
  const { error: showErrorToast } = toast;
  const { session, loading, error, deleteSession, refresh } = useSshServerSession(sshServerSessionId);

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
    return `/api/ssh-terminal?sshServerSessionId=${encodeURIComponent(sshServerSessionId)}`;
  }, [session, sshServerSessionId]);

  const hasPersistentSession = useMemo(() => {
    return session ? isPersistentTerminalSession(session) : false;
  }, [session]);

  const standalone = useStandaloneSession({ session, showErrorToast });

  const clipboard = useClipboard({ terminalRef, focusTerminal, showErrorToast, copyTextToClipboard });

  const connection = useTerminalConnection({
    terminalUrl,
    terminalRef,
    fitAddonRef,
    sessionKind: "standalone",
    focusTerminal,
    refresh,
    showErrorToast,
    copyTerminalClipboardText: clipboard.copyTerminalClipboardText,
    clearSelectedTerminalText: clipboard.clearSelectedTerminalText,
    loadStandaloneCredentialToken: standalone.loadStandaloneCredentialToken,
    setStandaloneCredentialToken: standalone.setStandaloneCredentialToken,
    setPendingStandaloneAction: standalone.setPendingStandaloneAction,
    setShowPasswordPrompt: standalone.setShowPasswordPrompt,
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

  // Track the visual viewport so the focus-mode layout can shrink when the
  // mobile on-screen keyboard is visible.
  const viewport = useVisualViewport(usesViewportAwareFocusMode);

  // Re-fit the terminal whenever the visual viewport height changes (keyboard
  // appears/disappears). A double-rAF delay lets the CSS layout settle first.
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
    // Double rAF to let CSS layout settle before fitting
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

  async function handleStandalonePasswordSubmit() {
    if (!session) {
      return;
    }

    const trimmedPassword = standalone.standalonePassword.trim();
    if (!trimmedPassword) {
      showErrorToast("Enter the SSH password for this server.");
      return;
    }

    try {
      await storeSshServerPassword(session.config.sshServerId, trimmedPassword);

      if (standalone.pendingStandaloneAction === "delete") {
        const success = await deleteSession({ password: trimmedPassword });
        if (success) {
          standalone.setStandalonePassword("");
          standalone.setShowPasswordPrompt(false);
          standalone.setPendingStandaloneAction(null);
          onBack?.();
        }
        return;
      }

      const token = await getStoredSshCredentialToken(session.config.sshServerId);
      if (!token) {
        showErrorToast("Failed to retrieve a valid SSH credential token.");
        return;
      }

      await connection.connectTerminal({ standaloneCredentialToken: token });
      standalone.setStandaloneCredentialToken(token);
      standalone.setStandalonePassword("");
      standalone.setShowPasswordPrompt(false);
      standalone.setPendingStandaloneAction(null);
    } catch (error) {
      showErrorToast(String(error));
    }
  }

  if (loading && !session) {
    return <div className="p-6 text-gray-500 dark:text-gray-400">Loading SSH server session...</div>;
  }

  if (!session) {
    return (
      <div className="p-6">
        {showBackButton && onBack && <Button variant="ghost" onClick={onBack}>← Back</Button>}
        <p className="mt-4 text-red-600 dark:text-red-400">{error || "SSH server session not found."}</p>
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

  // Single persistent layout — the terminal container ref is always on the same
  // DOM node so that useTerminalRenderer never needs to re-open the terminal
  // when toggling focus mode. Focus mode hides the chrome via conditional
  // rendering and changes the wrapper styles.
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
      {/* Main content area */}
      <div
        className={
          isFocusMode
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "flex-1 min-h-0 flex flex-col gap-2 overflow-hidden p-2 sm:p-3"
        }
      >
        {/* Session info & touch controls — hidden in focus mode */}
        {!isFocusMode && (
          <>
            <SshServerSessionInfoSection
              session={session}
              standaloneServerName={standalone.standaloneServerName}
              standaloneServerTarget={standalone.standaloneServerTarget}
            />

            <TouchControlsSection
              {...touchControlProps}
              onEnterFocusMode={toggleFocusMode}
            />

            {renderClipboardFallback(false)}
          </>
        )}

        {/* Terminal — always the same DOM node, never re-mounted */}
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

      {/* Focus mode bar — only shown in focus mode */}
      {isFocusMode && !forcedFocusMode && (
        <FocusModeBar
          {...touchControlProps}
          onExitFocusMode={toggleFocusMode}
        />
      )}

      <StandalonePasswordModal
        isOpen={standalone.showPasswordPrompt}
        onClose={() => {
          standalone.setShowPasswordPrompt(false);
          standalone.setPendingStandaloneAction(null);
        }}
        onSubmit={() => void handleStandalonePasswordSubmit()}
        password={standalone.standalonePassword}
        onPasswordChange={standalone.setStandalonePassword}
        pendingAction={standalone.pendingStandaloneAction}
        hasPersistentSession={hasPersistentSession}
      />
    </div>
  );
}
