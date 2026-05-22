import type { ComponentType } from "react";
import type { CreateSshSessionRequest, Task, SshConnectionMode, SshSession, Workspace } from "../../types";
import type { SshServerSession } from "../../types/ssh-server";
import type { SshSessionDetailsProps } from "../SshSessionDetails";
import type { ShellRoute } from "./shell-types";
import { CodeExplorerView } from "./code-explorer-view";

interface TaskFilesViewProps {
  task: Task;
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

export function TaskFilesView({
  task,
  workspace,
  sessions,
  headerOffsetClassName,
  startDirectory,
  createSession = async () => {
    throw new Error("Workspace SSH sessions are unavailable in task code explorer context.");
  },
  createStandaloneSession = async () => {
    throw new Error("Standalone SSH sessions are unavailable in task code explorer context.");
  },
  onNavigate,
  sshSessionDetailsComponent,
}: TaskFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "task", taskId: task.config.id, startDirectory }}
      tasks={[task]}
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
