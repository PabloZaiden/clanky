import { useCallback, useState } from "react";
import { useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import {
  getExecutionHostDefaultDirectory,
  getExecutionHostSourceId,
  type ExecutionHostDescriptor,
  type TerminalSession,
} from "@/shared";
import type { CreateTerminalSessionRequest } from "@/contracts";
import { TerminalSessionModeModal } from "./terminal-session-mode-modal";

export function ExecutionHostTerminalComposer({
  host,
  navigateWithinShell,
  onCreateTerminalSession,
}: {
  host: ExecutionHostDescriptor;
  navigateWithinShell: (route: WebAppRoute) => void;
  onCreateTerminalSession: (request: CreateTerminalSessionRequest) => Promise<TerminalSession>;
}) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const closeRoute: WebAppRoute = {
    view: "execution-host",
    hostKind: host.ref.kind,
    hostId: getExecutionHostSourceId(host.ref),
  };
  const handleSelection = useCallback(async (useTmux: boolean): Promise<void> => {
    if (submitting) {
      return;
    }

    setSubmitting(true);
    try {
      const session = await onCreateTerminalSession({
        executionHost: host.ref,
        name: `${host.name} terminal`,
        directory: getExecutionHostDefaultDirectory(host),
        connectionMode: "dtach",
        useTmux,
      });
      navigateWithinShell({ view: "terminal", terminalSessionId: session.config.id });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }, [host, navigateWithinShell, onCreateTerminalSession, submitting, toast]);

  return (
    <TerminalSessionModeModal
      isOpen
      submitting={submitting}
      onClose={() => navigateWithinShell(closeRoute)}
      onSelect={handleSelection}
    />
  );
}
