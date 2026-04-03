/**
 * Dedicated SSH session terminal view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FitAddon, Terminal } from "ghostty-web";
import { Button, ConfirmModal, EditIcon, StatusBadge } from "../common";
import { useSshSession, useToast } from "../../hooks";
import { RenameSshSessionModal } from "../RenameSshSessionModal";
import { isPersistentSshSession, writeTextToClipboard } from "../../utils";
import { isStandaloneSession } from "./session-utils";
import {
  TERMINAL_PADDING_BOTTOM_PX,
  TERMINAL_PADDING_TOP_PX,
  TERMINAL_PADDING_X_PX,
} from "./terminal-constants";
import { storeSshServerPassword, getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import { SessionInfoSection } from "./session-info-section";
import { TouchControlsSection } from "./touch-controls-section";
import { ClipboardFallbackCard } from "./clipboard-fallback-card";
import { StandalonePasswordModal } from "./standalone-password-modal";
import { useTerminalModifiers } from "./use-terminal-modifiers";
import { useTerminalKeyboard } from "./use-terminal-keyboard";
import { useClipboard } from "./use-clipboard";
import { useStandaloneSession } from "./use-standalone-session";
import { useSshConnection } from "./use-ssh-connection";
import { useTerminalRenderer } from "./use-terminal-renderer";
import { useFocusMode } from "./use-focus-mode";
import { FocusModeBar } from "./focus-mode-bar";
import { getFocusModeViewportStyle, useVisualViewport } from "./use-visual-viewport";

export interface SshSessionDetailsProps {
  sshSessionId: string;
  onBack?: () => void;
  showBackButton?: boolean;
  headerOffsetClassName?: string;
  copyTextToClipboard?: (text: string) => Promise<void>;
  forcedFocusMode?: boolean;
}

export function SshSessionDetails({
  sshSessionId,
  onBack,
  showBackButton = true,
  headerOffsetClassName,
  copyTextToClipboard = writeTextToClipboard,
  forcedFocusMode = false,
}: SshSessionDetailsProps) {
  const toast = useToast();
  const { error: showErrorToast, warning: showWarningToast } = toast;
  const { session, sessionKind, loading, error, deleteSession, refresh, updateSession } = useSshSession(sshSessionId);

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastShownNoticeRef = useRef<string | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const terminalUrl = useMemo(() => {
    if (!session) {
      return null;
    }
    if (isStandaloneSession(session)) {
      return `/api/ssh-terminal?sshServerSessionId=${encodeURIComponent(sshSessionId)}`;
    }
    return `/api/ssh-terminal?sshSessionId=${encodeURIComponent(sshSessionId)}`;
  }, [session, sshSessionId]);

  const hasPersistentSession = useMemo(() => {
    return session ? isPersistentSshSession(session) : false;
  }, [session]);

  const canRenameSession = sessionKind === "workspace";

  useEffect(() => {
    const notice = session?.state.notice ?? null;
    if (!notice) {
      lastShownNoticeRef.current = null;
      return;
    }
    if (notice === lastShownNoticeRef.current) {
      return;
    }
    lastShownNoticeRef.current = notice;
    showWarningToast(notice, { duration: 12_000 });
  }, [session?.state.notice, showWarningToast]);

  const standalone = useStandaloneSession({ session, sessionKind, showErrorToast });

  const clipboard = useClipboard({ terminalRef, focusTerminal, showErrorToast, copyTextToClipboard });

  const connection = useSshConnection({
    terminalUrl,
    terminalRef,
    fitAddonRef,
    sessionKind,
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

  // Track the visual viewport so the focus-mode layout can shrink when the
  // mobile on-screen keyboard is visible.
  const viewport = useVisualViewport(isFocusMode);

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

  const focusModeContainerStyle = getFocusModeViewportStyle(isFocusMode, viewport);

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

  async function handleDelete() {
    const success = await deleteSession();
    if (!success) {
      if (session && isStandaloneSession(session) && isPersistentSshSession(session)) {
        standalone.setPendingStandaloneAction("delete");
        standalone.setShowPasswordPrompt(true);
      }
      return;
    }
    setShowDeleteConfirm(false);
    onBack?.();
  }

  async function handleStandalonePasswordSubmit() {
    if (!session || !isStandaloneSession(session)) {
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
          setShowDeleteConfirm(false);
          onBack?.();
        }
        return;
      }

      const token = await getStoredSshCredentialToken(session.config.sshServerId);
      if (!token) {
        showErrorToast("Failed to retrieve a valid SSH credential token.");
        return;
      }

      standalone.setStandalonePassword("");
      standalone.setStandaloneCredentialToken(token);
      standalone.setShowPasswordPrompt(false);
      standalone.setPendingStandaloneAction(null);
      void connection.connectTerminal({ standaloneCredentialToken: token });
    } catch (error) {
      showErrorToast(String(error));
    }
  }

  async function handleRename(newName: string) {
    await updateSession({ name: newName });
  }

  if (loading && !session) {
    return <div className="p-6 text-gray-500 dark:text-gray-400">Loading SSH session...</div>;
  }

  if (!session) {
    return (
      <div className="p-6">
        {showBackButton && onBack && <Button variant="ghost" onClick={onBack}>← Back</Button>}
        <p className="mt-4 text-red-600 dark:text-red-400">{error || "SSH session not found."}</p>
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
    sendTerminalTextShortcut: keyboard.sendTerminalTextShortcut,
  };

  // Single persistent layout — the terminal container ref is always on the same
  // DOM node so that useTerminalRenderer never needs to re-open the terminal
  // when toggling focus mode. Focus mode hides the chrome via conditional
  // rendering and changes the wrapper styles.
  return (
    <div
      className={
        isFocusMode
          ? "flex h-full min-h-0 flex-col bg-[#1e1e1e]"
          : "h-full min-h-0 flex flex-col bg-gray-50 dark:bg-neutral-900"
      }
      style={focusModeContainerStyle}
    >
      {/* Header — hidden in focus mode */}
      {!isFocusMode && (
        <div className="border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-neutral-800">
          <div
            className={[
              headerOffsetClassName ?? "ml-14 sm:ml-16 lg:ml-0",
              "flex min-h-14 flex-wrap items-center justify-between gap-1.5",
            ].join(" ")}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {showBackButton && onBack && (
                <Button variant="ghost" size="xs" onClick={onBack}>← Back</Button>
              )}
              <h1 className="min-w-0 break-words text-base font-semibold text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                {session.config.name}
              </h1>
              <StatusBadge variant={connection.socketStatus === "open" ? "success" : connection.socketStatus === "connecting" ? "info" : "warning"}>
                {connection.socketStatus === "open" ? "connected" : connection.socketStatus === "closed" ? "disconnected" : "connecting"}
              </StatusBadge>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {canRenameSession && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowRenameModal(true)}
                  aria-label="Rename SSH session"
                  title="Rename SSH session"
                >
                  <span className="flex items-center gap-1">
                    <EditIcon size="h-3.5 w-3.5" />
                    Rename
                  </span>
                </Button>
              )}
              <Button variant="danger" size="xs" onClick={() => setShowDeleteConfirm(true)}>
                Delete Session
              </Button>
            </div>
          </div>
        </div>
      )}

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
            <SessionInfoSection
              session={session}
              standaloneServerName={standalone.standaloneServerName}
              standaloneServerTarget={standalone.standaloneServerTarget}
            />

            <TouchControlsSection
              {...touchControlProps}
              onEnterFocusMode={toggleFocusMode}
            />

            {clipboard.pendingTerminalClipboardText !== null && (
              <ClipboardFallbackCard
                pendingText={clipboard.pendingTerminalClipboardText}
                onDismiss={() => clipboard.setPendingTerminalClipboardText(null)}
                onRetry={clipboard.retryPendingTerminalClipboardCopy}
              />
            )}
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
            className="relative box-border min-h-0 h-full flex-1 bg-[#1e1e1e] w-full"
            style={{
              padding: `${TERMINAL_PADDING_TOP_PX}px ${TERMINAL_PADDING_X_PX}px ${TERMINAL_PADDING_BOTTOM_PX}px`,
            }}
          />
        </div>
      </div>

      {/* Focus mode bar — only shown in focus mode */}
      {isFocusMode && !forcedFocusMode && (
        <FocusModeBar
          {...touchControlProps}
          onExitFocusMode={toggleFocusMode}
        />
      )}

      {/* Modals */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => void handleDelete()}
        title="Delete SSH session?"
        message={hasPersistentSession
          ? "This removes the Ralpher session metadata and attempts to stop the remote persistent session."
          : "This removes the saved Ralpher session metadata. Direct SSH mode does not keep a remote persistent session."}
        confirmLabel="Delete"
        loading={false}
      />
      {!isFocusMode && (
        <RenameSshSessionModal
          isOpen={showRenameModal}
          onClose={() => setShowRenameModal(false)}
          currentName={sessionKind === "workspace" ? session.config.name : ""}
          onRename={handleRename}
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
