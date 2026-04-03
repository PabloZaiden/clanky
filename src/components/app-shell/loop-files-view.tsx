import type { Loop, SshSession, Workspace } from "../../types";
import { getOrCreateLoopSshSessionApi } from "../../hooks/loop-actions/ssh-actions";
import type { ShellRoute } from "./shell-types";
import { FileExplorerView } from "./file-explorer-view";

interface LoopFilesViewProps {
  loop: Loop;
  workspace: Workspace | null;
  sessions: SshSession[];
  headerOffsetClassName?: string;
  startDirectory?: string;
  onNavigate: (route: ShellRoute) => void;
}

function getLoopRootDirectory(loop: Loop): string {
  return loop.state.git?.worktreePath?.trim() || loop.config.directory;
}

function supportsLoopTerminal(loop: Loop, sessions: SshSession[]): boolean {
  if (sessions.some((session) => session.config.loopId === loop.config.id)) {
    return true;
  }

  return loop.config.useWorktree || Boolean(loop.state.git?.worktreePath);
}

export function LoopFilesView({
  loop,
  workspace,
  sessions,
  headerOffsetClassName,
  startDirectory,
  onNavigate,
}: LoopFilesViewProps) {
  const loopRootDirectory = getLoopRootDirectory(loop);
  const effectiveStartDirectory = startDirectory ?? loopRootDirectory;
  const loopSessions = sessions.filter((session) => session.config.loopId === loop.config.id);
  const hasTerminal = workspace?.serverSettings.agent.transport === "ssh" && supportsLoopTerminal(loop, loopSessions);

  return (
    <FileExplorerView
      title={`${loop.config.name} editor`}
      description={loopRootDirectory}
      defaultRootDirectory={loopRootDirectory}
      headerOffsetClassName={headerOffsetClassName}
      backLabel="Back to loop"
      backRoute={{ view: "loop", loopId: loop.config.id }}
      onNavigate={onNavigate}
      target={{ type: "workspace", id: loop.config.workspaceId, startDirectory: effectiveStartDirectory }}
      buildRoute={(nextStartDirectory) => ({ view: "loop-files", loopId: loop.config.id, startDirectory: nextStartDirectory })}
      sessions={loopSessions}
      hasTerminal={hasTerminal}
      emptyTerminalMessage={hasTerminal
        ? "Choose the loop SSH session or open the loop terminal."
        : "This loop does not have a loop-linked terminal yet. Start or reconnect the loop SSH session from the info tab."}
      terminalSelectLabel="Select loop SSH session"
      onCreateTerminal={async () => await getOrCreateLoopSshSessionApi(loop.config.id)}
      testIdPrefix="workspace"
    />
  );
}
