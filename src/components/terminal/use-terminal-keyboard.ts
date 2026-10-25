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
  sendTerminalInput: (data: string, options?: { focusTerminal?: boolean; notifyOnFailure?: boolean }) => Promise<boolean>;
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
  const sendEncodedTerminalKey = useCallback(async (key: TerminalSpecialKey | string) => {
    const encoded = encodeTerminalInput(key, terminalModifiers);
    if (!encoded) {
      showErrorToast("That key combination is not supported.");
      return false;
    }
    const didSend = await sendTerminalInput(encoded);
    if (didSend && terminalModifiersRef.current === terminalModifiers) {
      resetTerminalModifiers();
    }
  }, [resetTerminalModifiers, sendTerminalInput, terminalModifiers, terminalModifiersRef, showErrorToast]);

  const sendCtrlC = useCallback(async () => {
    const modifiers = terminalModifiersRef.current;
    const encoded = encodeTerminalInput("c", { ctrl: true, alt: false, shift: false });
    if (!encoded) {
      showErrorToast("Ctrl+C is not supported.");
      return;
    }
    const didSend = await sendTerminalInput(encoded);
    if (didSend && terminalModifiersRef.current === modifiers) {
      resetTerminalModifiers();
    }
  }, [resetTerminalModifiers, sendTerminalInput, showErrorToast, terminalModifiersRef]);

  const sendTerminalKeystroke = useCallback(async (data: string) => {
    const modifiers = terminalModifiersRef.current;
    if (!hasActiveTerminalModifiers(modifiers)) {
      return await sendTerminalInput(data, { notifyOnFailure: false });
    }
    const encoded = encodeTerminalDataInput(data, modifiers);
    if (!encoded) {
      showErrorToast("That key combination is not supported.");
      return false;
    }
    const didSend = await sendTerminalInput(encoded, { notifyOnFailure: false });
    if (didSend && terminalModifiersRef.current === modifiers) {
      resetTerminalModifiers();
    }
    return didSend;
  }, [resetTerminalModifiers, sendTerminalInput, showErrorToast, terminalModifiersRef]);

  return { sendEncodedTerminalKey, sendCtrlC, sendTerminalKeystroke };
}
