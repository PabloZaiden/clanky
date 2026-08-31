import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { CodeExplorerView } from "./code-explorer-view";

interface ServerFilesViewProps {
  server: SshServer;
  sessions: SshServerSession[];
  startDirectory?: string;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: import("@/shared").TerminalConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  onNavigate: (route: WebAppRoute) => void;
}

export function ServerFilesView({
  server,
  sessions,
  startDirectory,
  createStandaloneSession,
  onNavigate,
}: ServerFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "server", serverId: server.config.id, startDirectory }}
      tasks={[]}
      chats={[]}
      workspaces={[]}
      terminalSessions={[]}
      servers={[server]}
      sessionsByServerId={{ [server.config.id]: sessions }}
      createTerminalSession={async () => {
        throw new Error("Workspace terminal sessions are unavailable in server code explorer context.");
      }}
      createStandaloneSession={createStandaloneSession}
      onNavigate={onNavigate}
    />
  );
}
