/**
 * Hooks for sending data over a terminal WebSocket.
 */

import { useCallback } from "react";

export type SendTerminalPayloadFn = (
  payload: Record<string, unknown>,
  options?: { focusTerminal?: boolean; notifyOnFailure?: boolean },
) => boolean;

interface UseTerminalSenderParams {
  terminalSocketRef: React.MutableRefObject<WebSocket | null>;
  terminalReadyRef: React.MutableRefObject<boolean>;
  focusTerminal: () => void;
  showErrorToast: (message: string) => void;
}

export function useTerminalSender({
  terminalSocketRef,
  terminalReadyRef,
  focusTerminal,
  showErrorToast,
}: UseTerminalSenderParams) {
  const sendTerminalPayload: SendTerminalPayloadFn = useCallback((payload, options) => {
    if (terminalSocketRef.current?.readyState !== WebSocket.OPEN || !terminalReadyRef.current) {
      if (options?.notifyOnFailure ?? true) {
        showErrorToast("Terminal is still connecting.");
      }
      return false;
    }
    terminalSocketRef.current.send(JSON.stringify(payload));
    if (options?.focusTerminal ?? true) {
      focusTerminal();
    }
    return true;
  }, [focusTerminal, showErrorToast, terminalReadyRef, terminalSocketRef]);

  const sendTerminalInput = useCallback((
    data: string,
    options?: { focusTerminal?: boolean; notifyOnFailure?: boolean },
  ): boolean => {
    return sendTerminalPayload({ type: "terminal.input", data }, options);
  }, [sendTerminalPayload]);

  return { sendTerminalPayload, sendTerminalInput };
}
