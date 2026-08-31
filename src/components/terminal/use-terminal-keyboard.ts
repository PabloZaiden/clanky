/**
 * Hook for sending keyboard input to the terminal.
 */

import { useCallback } from "react";
import type React from "react";
import {
  encodeTerminalDataInput,
  encodeTerminalInput,
  hasActiveTerminalModifiers,
  type TerminalModifierState,
  type TerminalSpecialKey,
} from "../../utils/terminal-keys";

interface UseTerminalKeyboardParams {
  terminalModifiers: TerminalModifierState;
  terminalModifiersRef: React.MutableRefObject<TerminalModifierState>;
  sendTerminalInput: (data: string, options?: { focusTerminal?: boolean; notifyOnFailure?: boolean }) => boolean;
  resetTerminalModifiers: () => void;
  showErrorToast: (message: string) => void;
}

export function useTerminalKeyboard({
  terminalModifiers,
  terminalModifiersRef,
  sendTerminalInput,
  resetTerminalModifiers,
  showErrorToast,
}: UseTerminalKeyboardParams) {
  const sendEncodedTerminalKey = useCallback((key: TerminalSpecialKey | string) => {
    const encoded = encodeTerminalInput(key, terminalModifiers);
    if (!encoded) {
      showErrorToast("That key combination is not supported.");
      return;
    }
    const didSend = sendTerminalInput(encoded);
    if (didSend) {
      resetTerminalModifiers();
    }
  }, [resetTerminalModifiers, sendTerminalInput, terminalModifiers, showErrorToast]);

  const sendCtrlC = useCallback(() => {
    const encoded = encodeTerminalInput("c", { ctrl: true, alt: false, shift: false });
    if (!encoded) {
      showErrorToast("Ctrl+C is not supported.");
      return;
    }
    const didSend = sendTerminalInput(encoded);
    if (didSend) {
      resetTerminalModifiers();
    }
  }, [resetTerminalModifiers, sendTerminalInput, showErrorToast]);

  const sendTerminalKeystroke = useCallback((data: string) => {
    const modifiers = terminalModifiersRef.current;
    if (!hasActiveTerminalModifiers(modifiers)) {
      return sendTerminalInput(data, { notifyOnFailure: false });
    }
    const encoded = encodeTerminalDataInput(data, modifiers);
    if (!encoded) {
      showErrorToast("That key combination is not supported.");
      return;
    }
    const didSend = sendTerminalInput(encoded, { notifyOnFailure: false });
    if (didSend) {
      resetTerminalModifiers();
    }
  }, [resetTerminalModifiers, sendTerminalInput, showErrorToast, terminalModifiersRef]);

  return { sendEncodedTerminalKey, sendCtrlC, sendTerminalKeystroke };
}
