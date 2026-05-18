/**
 * Hook for clipboard and terminal text selection state.
 */

import { useCallback, useState } from "react";
import type React from "react";
import type { Terminal } from "@xterm/xterm";

interface UseClipboardParams {
  terminalRef: React.MutableRefObject<Terminal | null>;
  focusTerminal: () => void;
  showErrorToast: (message: string) => void;
  copyTextToClipboard: (text: string) => Promise<void>;
}

export function useClipboard({
  terminalRef,
  focusTerminal,
  showErrorToast,
  copyTextToClipboard,
}: UseClipboardParams) {
  const [hasSelectedTerminalText, setHasSelectedTerminalText] = useState(false);
  const [pendingTerminalClipboardText, setPendingTerminalClipboardText] = useState<string | null>(null);

  const syncTerminalSelectionState = useCallback(() => {
    setHasSelectedTerminalText(Boolean(terminalRef.current?.hasSelection()));
  }, [terminalRef]);

  const clearSelectedTerminalText = useCallback((options?: { clearTerminalSelection?: boolean }) => {
    if (options?.clearTerminalSelection ?? true) {
      terminalRef.current?.clearSelection();
    }
    setHasSelectedTerminalText(false);
  }, [terminalRef]);

  const copyTerminalClipboardText = useCallback(async (
    text: string,
    options?: { userInitiated?: boolean },
  ) => {
    try {
      await copyTextToClipboard(text);
      setPendingTerminalClipboardText(null);
    } catch (error) {
      setPendingTerminalClipboardText(text);
      if (options?.userInitiated) {
        showErrorToast(`Failed to copy terminal text to the clipboard: ${String(error)}`);
      }
    } finally {
      focusTerminal();
    }
  }, [copyTextToClipboard, focusTerminal, showErrorToast]);

  const retryPendingTerminalClipboardCopy = useCallback(() => {
    if (!pendingTerminalClipboardText) {
      return;
    }
    void copyTerminalClipboardText(pendingTerminalClipboardText, { userInitiated: true });
  }, [copyTerminalClipboardText, pendingTerminalClipboardText]);

  const copySelectedTerminalText = useCallback(() => {
    const terminal = terminalRef.current;
    const nextSelectedText = terminal?.getSelection() ?? "";
    if (!nextSelectedText) {
      focusTerminal();
      return;
    }
    void copyTerminalClipboardText(nextSelectedText, { userInitiated: true });
  }, [copyTerminalClipboardText, focusTerminal, terminalRef]);

  return {
    hasSelectedTerminalText,
    setHasSelectedTerminalText,
    pendingTerminalClipboardText,
    setPendingTerminalClipboardText,
    syncTerminalSelectionState,
    clearSelectedTerminalText,
    copyTerminalClipboardText,
    retryPendingTerminalClipboardCopy,
    copySelectedTerminalText,
  };
}
