import type { ComponentType } from "react";
import type { Task, SshConnectionMode, SshSession, Workspace } from "@/shared";
import type { CreateSshSessionRequest } from "@/contracts";
import type { SshServerSession } from "@/shared/ssh-server";
import type { SshSessionDetailsProps } from "../SshSessionDetails";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { CodeExplorerView } from "./code-explorer-view";

interface TaskFilesViewProps {
  task: Task;
  workspace: Workspace | null;
  sessions: SshSession[];
  startDirectory?: string;
  createSession?: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession?: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  onNavigate: (route: WebAppRoute) => void;
  sshSessionDetailsComponent?: ComponentType<SshSessionDetailsProps>;
}

export function TaskFilesView({
  task,
  workspace,
  sessions,
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
      createSession={createSession}
      createStandaloneSession={createStandaloneSession}
      onNavigate={onNavigate}
      sshSessionDetailsComponent={sshSessionDetailsComponent}
    />
  );
}
