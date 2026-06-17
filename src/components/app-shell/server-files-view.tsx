import type { CreateSshSessionRequest, SshConnectionMode, SshSession } from "../../types";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import type { ShellRoute } from "./shell-types";
import { CodeExplorerView } from "./code-explorer-view";

interface ServerFilesViewProps {
  server: SshServer;
  sessions: SshServerSession[];
  headerOffsetClassName?: string;
  startDirectory?: string;
  createSession?: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  onNavigate: (route: ShellRoute) => void;
}

export function ServerFilesView({
  server,
  sessions,
  headerOffsetClassName,
  startDirectory,
  createSession = async () => {
    throw new Error("Workspace SSH sessions are unavailable in server code explorer context.");
  },
  createStandaloneSession,
  onNavigate,
}: ServerFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "server", serverId: server.config.id, startDirectory }}
      tasks={[]}
      chats={[]}
      workspaces={[]}
      sessions={[]}
      servers={[server]}
      sessionsByServerId={{ [server.config.id]: sessions }}
      headerOffsetClassName={headerOffsetClassName}
      createSession={createSession}
      createStandaloneSession={createStandaloneSession}
      onNavigate={onNavigate}
    />
  );
}
