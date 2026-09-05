import type { Task, Workspace, TerminalSession } from "@/shared";
import type { CreateTerminalSessionRequest } from "@/contracts";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { CodeExplorerView } from "./code-explorer-view";

interface TaskFilesViewProps {
  task: Task;
  workspace: Workspace | null;
  sessions: TerminalSession[];
  startDirectory?: string;
  createTerminalSession: (request: CreateTerminalSessionRequest) => Promise<TerminalSession>;
  onNavigate: (route: WebAppRoute) => void;
}

export function TaskFilesView({
  task,
  workspace,
  sessions,
  startDirectory,
  createTerminalSession,
  onNavigate,
}: TaskFilesViewProps) {
  return (
    <CodeExplorerView
      routeTarget={{ contentType: "task", taskId: task.config.id, startDirectory }}
      tasks={[task]}
      chats={[]}
      workspaces={workspace ? [workspace] : []}
      terminalSessions={sessions}
      createTerminalSession={createTerminalSession}
      onNavigate={onNavigate}
    />
  );
}
