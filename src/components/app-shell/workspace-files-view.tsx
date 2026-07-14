import type { ComponentType } from "react";
import type { SshConnectionMode, SshSession, Workspace } from "@/shared";
import type { CreateSshSessionRequest } from "@/contracts";
import type { SshServerSession } from "@/shared/ssh-server";
import type { SshSessionDetailsProps } from "../SshSessionDetails";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { CodeExplorerView } from "./code-explorer-view";

interface WorkspaceFilesViewProps {
  workspace: Workspace;
  sessions: SshSession[];
  startDirectory?: string;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession?: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  onNavigate: (route: WebAppRoute) => void;
  sshSessionDetailsComponent?: ComponentType<SshSessionDetailsProps>;
}

export function WorkspaceFilesView({
  workspace,
  sessions,
  startDirectory,
  createSession,
  createStandaloneSession = async () => {
    throw new Error("Standalone SSH sessions are unavailable in workspace code explorer context.");
  },
  onNavigate,
  sshSessionDetailsComponent,
}: WorkspaceFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "workspace", workspaceId: workspace.id, startDirectory }}
      tasks={[]}
      chats={[]}
      workspaces={[workspace]}
      sessions={sessions}
      servers={[]}
      sessionsByServerId={{}}
      createSession={createSession}
      createStandaloneSession={createStandaloneSession}
      onNavigate={onNavigate}
      sshSessionDetailsComponent={sshSessionDetailsComponent}
    />
  );
}
