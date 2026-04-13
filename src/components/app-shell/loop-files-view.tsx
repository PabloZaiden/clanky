import type { ComponentType } from "react";
import type { CreateSshSessionRequest, Loop, SshConnectionMode, SshSession, Workspace } from "../../types";
import type { SshServerSession } from "../../types/ssh-server";
import type { SshSessionDetailsProps } from "../SshSessionDetails";
import type { ShellRoute } from "./shell-types";
import { CodeExplorerView } from "./code-explorer-view";

interface LoopFilesViewProps {
  loop: Loop;
  workspace: Workspace | null;
  sessions: SshSession[];
  headerOffsetClassName?: string;
  startDirectory?: string;
  createSession?: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession?: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode },
  ) => Promise<SshServerSession>;
  onNavigate: (route: ShellRoute) => void;
  sshSessionDetailsComponent?: ComponentType<SshSessionDetailsProps>;
}

export function LoopFilesView({
  loop,
  workspace,
  sessions,
  headerOffsetClassName,
  startDirectory,
  createSession = async () => {
    throw new Error("Workspace SSH sessions are unavailable in loop code explorer context.");
  },
  createStandaloneSession = async () => {
    throw new Error("Standalone SSH sessions are unavailable in loop code explorer context.");
  },
  onNavigate,
  sshSessionDetailsComponent,
}: LoopFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "loop", loopId: loop.config.id, startDirectory }}
      loops={[loop]}
      chats={[]}
      workspaces={workspace ? [workspace] : []}
      sessions={sessions}
      servers={[]}
      sessionsByServerId={{}}
      headerOffsetClassName={headerOffsetClassName}
      createSession={createSession}
      createStandaloneSession={createStandaloneSession}
      onNavigate={onNavigate}
      sshSessionDetailsComponent={sshSessionDetailsComponent}
    />
  );
}
