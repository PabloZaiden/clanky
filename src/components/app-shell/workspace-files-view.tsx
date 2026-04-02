import type { CreateSshSessionRequest, SshSession, Workspace } from "../../types";
import type { ShellRoute } from "./shell-types";
import { FileExplorerView } from "./file-explorer-view";

interface WorkspaceFilesViewProps {
  workspace: Workspace;
  sessions: SshSession[];
  headerOffsetClassName?: string;
  startDirectory?: string;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  onNavigate: (route: ShellRoute) => void;
}

export function WorkspaceFilesView({
  workspace,
  sessions,
  headerOffsetClassName,
  startDirectory,
  createSession,
  onNavigate,
}: WorkspaceFilesViewProps) {
  const workspaceSessions = sessions.filter((session) => session.config.workspaceId === workspace.id);
  const hasSshTransport = workspace.serverSettings.agent.transport === "ssh";

  return (
    <FileExplorerView
      title={`${workspace.name} editor`}
      description={workspace.directory}
      defaultRootDirectory={workspace.directory}
      headerOffsetClassName={headerOffsetClassName}
      backLabel="Back to workspace"
      backRoute={{ view: "workspace", workspaceId: workspace.id }}
      onNavigate={onNavigate}
      target={{ type: "workspace", id: workspace.id, startDirectory }}
      sessions={workspaceSessions}
      hasTerminal={hasSshTransport}
      emptyTerminalMessage={hasSshTransport
        ? "Choose an existing SSH session or create a new one."
        : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable."}
      terminalSelectLabel="Select workspace SSH session"
      onCreateTerminal={async () => await createSession({ workspaceId: workspace.id })}
      testIdPrefix="workspace"
    />
  );
}
