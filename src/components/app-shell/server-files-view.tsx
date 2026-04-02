import type { SshServerSession } from "../../types/ssh-server";
import type { SshConnectionMode } from "../../types";
import type { SshServer } from "../../types/ssh-server";
import type { ShellRoute } from "./shell-types";
import { FileExplorerView } from "./file-explorer-view";

interface ServerFilesViewProps {
  server: SshServer;
  sessions: SshServerSession[];
  headerOffsetClassName?: string;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode },
  ) => Promise<SshServerSession>;
  onNavigate: (route: ShellRoute) => void;
}

export function ServerFilesView({
  server,
  sessions,
  headerOffsetClassName,
  createStandaloneSession,
  onNavigate,
}: ServerFilesViewProps) {
  return (
    <FileExplorerView
      title={`${server.config.name} editor`}
      description={server.config.repositoriesBasePath?.trim() || "/"}
      headerOffsetClassName={headerOffsetClassName}
      backLabel="Back to server"
      backRoute={{ view: "ssh-server", serverId: server.config.id }}
      onNavigate={onNavigate}
      target={{ type: "server", id: server.config.id }}
      sessions={sessions}
      hasTerminal={true}
      emptyTerminalMessage="Choose an existing standalone SSH session or create a new one."
      terminalSelectLabel="Select standalone SSH session"
      onCreateTerminal={async () => await createStandaloneSession(server.config.id)}
      testIdPrefix="server"
    />
  );
}
