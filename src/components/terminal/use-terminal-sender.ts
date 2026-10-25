/**
 * Hooks for sending data over an application terminal channel.
 */

import { useCallback } from "react";
import { createLogger, type WebAppDuplex } from "@pablozaiden/webapp/web";

const log = createLogger("terminal-sender");

export type SendTerminalPayloadFn = (
  payload: Record<string, unknown>,
  options?: { focusTerminal?: boolean; notifyOnFailure?: boolean },
) => Promise<boolean>;

interface UseTerminalSenderParams {
  terminalSocketRef: React.MutableRefObject<WebAppDuplex | null>;
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
  const sendTerminalPayload: SendTerminalPayloadFn = useCallback(async (payload, options) => {
    const channel = terminalSocketRef.current;
    if (!channel || !terminalReadyRef.current) {
      if (options?.notifyOnFailure ?? true) {
        showErrorToast("Terminal is still connecting.");
      }
      return false;
    }
    try {
      await channel.send(JSON.stringify(payload));
      if (terminalSocketRef.current !== channel) return false;
      if (options?.focusTerminal ?? true) focusTerminal();
      return true;
    } catch (error) {
      log.error("Terminal send failed", { error: String(error) });
      if (terminalSocketRef.current === channel && terminalReadyRef.current) {
        terminalReadyRef.current = false;
        showErrorToast("Terminal input could not be sent. Reconnect before trying again.");
      }
      try {
        await channel.close();
      } catch (cleanup) {
        log.error("Terminal failed to close after an unsuccessful send", { error: String(cleanup) });
      }
      return false;
    }
  }, [focusTerminal, showErrorToast, terminalReadyRef, terminalSocketRef]);

  const sendTerminalInput = useCallback(async (
    data: string,
    options?: { focusTerminal?: boolean; notifyOnFailure?: boolean },
  ): Promise<boolean> => {
    return await sendTerminalPayload({ type: "terminal.input", data }, options);
  }, [sendTerminalPayload]);

  return { sendTerminalPayload, sendTerminalInput };
}
