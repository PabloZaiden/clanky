/**
 * Hook for managing terminal modifier key state (Ctrl, Alt, Shift).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultTerminalModifiers,
  type TerminalModifierState,
} from "../../utils/terminal-keys";

export function useTerminalModifiers(focusTerminal: () => void) {
  const [terminalModifiers, setTerminalModifiers] = useState<TerminalModifierState>(defaultTerminalModifiers);
  const terminalModifiersRef = useRef<TerminalModifierState>(defaultTerminalModifiers);

  useEffect(() => {
    terminalModifiersRef.current = terminalModifiers;
  }, [terminalModifiers]);

  const resetTerminalModifiers = useCallback(() => {
    setTerminalModifiers(defaultTerminalModifiers);
  }, []);

  const toggleTerminalModifier = useCallback((modifier: keyof TerminalModifierState) => {
    setTerminalModifiers((current) => ({
      ...current,
      [modifier]: !current[modifier],
    }));
    focusTerminal();
  }, [focusTerminal]);

  return { terminalModifiers, terminalModifiersRef, resetTerminalModifiers, toggleTerminalModifier };
}
