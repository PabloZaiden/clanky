import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type {
  ExecutionHostDescriptor,
  TerminalSession,
} from "@/shared";
import { getExecutionHostDefaultDirectory, getExecutionHostSourceId } from "@/shared";
import type { CreateTerminalSessionRequest } from "@/contracts";
import { FileExplorerView } from "./file-explorer-view";

interface ExecutionHostFilesViewProps {
  host: ExecutionHostDescriptor;
  startDirectory?: string;
  terminalSessions: TerminalSession[];
  createTerminalSession: (
    request: CreateTerminalSessionRequest,
  ) => Promise<TerminalSession>;
  onNavigate: (route: WebAppRoute) => void;
}

function executionHostId(host: ExecutionHostDescriptor): string {
  return getExecutionHostSourceId(host.ref);
}

export function ExecutionHostFilesView({
  host,
  startDirectory,
  terminalSessions,
  createTerminalSession,
  onNavigate,
}: ExecutionHostFilesViewProps) {
  const hostId = executionHostId(host);
  const sessions = terminalSessions.filter((session) => {
    const ref = session.config.executionHostBinding?.host;
    if (!ref || ref.kind !== host.ref.kind) {
      return false;
    }
    return getExecutionHostSourceId(ref) === hostId;
  });

  return (
    <FileExplorerView
      title={`${host.name} files`}
      defaultRootDirectory={getExecutionHostDefaultDirectory(host)}
      backRoute={{
        view: "execution-host",
        hostKind: host.ref.kind,
        hostId,
      }}
      onNavigate={onNavigate}
      target={{
        type: "executionHost",
        kind: host.ref.kind,
        id: hostId,
        startDirectory,
      }}
      sessions={sessions}
      hasTerminal={host.capabilities.interactiveTerminal !== undefined}
      emptyTerminalMessage="Create a terminal on this server to open it beside the files."
      terminalSelectLabel="Server terminal"
      onCreateTerminal={async (options) => await createTerminalSession({
        executionHost: host.ref,
        name: `${host.name} terminal`,
        directory: startDirectory ?? getExecutionHostDefaultDirectory(host),
        connectionMode: "direct",
        useTmux: options?.useTmux ?? false,
      })}
      canChooseTerminalTmux
      testIdPrefix="server"
      buildRoute={(directory) => ({
        view: "execution-host-files",
        hostKind: host.ref.kind,
        hostId,
        startDirectory: directory,
      })}
    />
  );
}
