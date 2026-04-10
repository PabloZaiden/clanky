import type { CreateSshSessionRequest, SshConnectionMode, SshSession, Workspace } from "../../types";
import type { SshServerSession } from "../../types/ssh-server";
import type { ShellRoute } from "./shell-types";
import { CodeExplorerView } from "./code-explorer-view";

interface WorkspaceFilesViewProps {
  workspace: Workspace;
  sessions: SshSession[];
  headerOffsetClassName?: string;
  startDirectory?: string;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession?: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode },
  ) => Promise<SshServerSession>;
  onNavigate: (route: ShellRoute) => void;
}

export function WorkspaceFilesView({
  workspace,
  sessions,
  headerOffsetClassName,
  startDirectory,
  createSession,
  createStandaloneSession = async () => {
    throw new Error("Standalone SSH sessions are unavailable in workspace code explorer context.");
  },
  onNavigate,
}: WorkspaceFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "workspace", workspaceId: workspace.id, startDirectory }}
      loops={[]}
      chats={[]}
      workspaces={[workspace]}
      sessions={sessions}
      servers={[]}
      sessionsByServerId={{}}
      headerOffsetClassName={headerOffsetClassName}
      createSession={createSession}
      createStandaloneSession={createStandaloneSession}
      onNavigate={onNavigate}
    />
  );
}
