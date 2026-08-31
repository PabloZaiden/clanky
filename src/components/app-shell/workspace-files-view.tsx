import type { Workspace, WorkspaceTerminalSession } from "@/shared";
import type { CreateTerminalSessionRequest } from "@/contracts";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { CodeExplorerView } from "./code-explorer-view";

interface WorkspaceFilesViewProps {
  workspace: Workspace;
  sessions: WorkspaceTerminalSession[];
  startDirectory?: string;
  createTerminalSession: (request: CreateTerminalSessionRequest) => Promise<WorkspaceTerminalSession>;
  onNavigate: (route: WebAppRoute) => void;
}

export function WorkspaceFilesView({
  workspace,
  sessions,
  startDirectory,
  createTerminalSession,
  onNavigate,
}: WorkspaceFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "workspace", workspaceId: workspace.id, startDirectory }}
      tasks={[]}
      chats={[]}
      workspaces={[workspace]}
      terminalSessions={sessions}
      servers={[]}
      sessionsByServerId={{}}
      createTerminalSession={createTerminalSession}
      onNavigate={onNavigate}
    />
  );
}
