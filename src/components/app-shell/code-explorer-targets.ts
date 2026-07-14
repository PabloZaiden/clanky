import type { Chat, Task, SshConnectionMode, SshSession, Workspace } from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateSshSessionRequest } from "@/contracts";
import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import { getOrCreateTaskSshSessionApi } from "../../hooks/task-actions/ssh-actions";
import type { CodeExplorerTarget } from "./shell-types";

type ExplorerSession = SshSession | SshServerSession;

export interface CodeExplorerTerminalOptions {
  useTmux?: boolean;
}

export interface CodeExplorerOption {
  id: string;
  kind: CodeExplorerTarget["contentType"];
  label: string;
  description: string;
  target: CodeExplorerTarget;
}

export interface CodeExplorerOptionGroup {
  kind: CodeExplorerTarget["contentType"];
  label: string;
  options: CodeExplorerOption[];
}

const CODE_EXPLORER_OPTION_GROUP_ORDER: CodeExplorerTarget["contentType"][] = [
  "workspace",
  "task",
  "server",
  "chat",
];

const CODE_EXPLORER_OPTION_GROUP_LABELS: Record<CodeExplorerTarget["contentType"], string> = {
  workspace: "Workspaces",
  task: "Tasks",
  server: "SSH servers",
  chat: "Chats",
};

export interface ResolvedCodeExplorerTarget {
  routeTarget: CodeExplorerTarget;
  title: string;
  description: string;
  defaultRootDirectory: string;
  backLabel: string;
  backRoute: WebAppRoute;
  target: { type: "workspace" | "server"; id: string; startDirectory?: string };
  buildRoute: (startDirectory?: string) => WebAppRoute;
  sessions: ExplorerSession[];
  hasTerminal: boolean;
  emptyTerminalMessage: string;
  terminalSelectLabel: string;
  onCreateTerminal: (options?: CodeExplorerTerminalOptions) => Promise<ExplorerSession>;
  canChooseTerminalTmux: boolean;
  testIdPrefix: "workspace" | "server";
  credentialPromptName?: string;
  initialFilePath?: string;
}

interface ResolveCodeExplorerTargetArgs {
  target?: CodeExplorerTarget;
  workspaces: Workspace[];
  tasks: Task[];
  chats: Chat[];
  servers: SshServer[];
  sessions: SshSession[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
}

function trimDirectory(directory: string | undefined): string {
  return directory?.trim() || "/";
}

export function getTaskCodeExplorerRootDirectory(task: Task): string {
  return trimDirectory(task.state.git?.worktreePath || task.config.directory);
}

export function getChatCodeExplorerRootDirectory(chat: Chat): string {
  return trimDirectory(chat.state.worktree?.worktreePath || chat.config.directory);
}

export function getCodeExplorerTargetId(target: CodeExplorerTarget): string {
  switch (target.contentType) {
    case "workspace":
      return target.workspaceId;
    case "task":
      return target.taskId;
    case "server":
      return target.serverId;
    case "chat":
      return target.chatId;
  }
}

function supportsTaskTerminal(task: Task, sessions: SshSession[]): boolean {
  if (sessions.some((session) => session.config.taskId === task.config.id)) {
    return true;
  }

  return task.config.useWorktree || Boolean(task.state.git?.worktreePath);
}

export function getCodeExplorerOptions({
  workspaces,
  tasks,
  chats,
  servers,
}: Pick<ResolveCodeExplorerTargetArgs, "workspaces" | "tasks" | "chats" | "servers">): CodeExplorerOption[] {
  return [
    ...workspaces.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      kind: "workspace" as const,
      label: workspace.name,
      description: workspace.directory,
      target: { contentType: "workspace" as const, workspaceId: workspace.id },
    })),
    ...tasks.map((task) => ({
      id: `task:${task.config.id}`,
      kind: "task" as const,
      label: task.config.name,
      description: getTaskCodeExplorerRootDirectory(task),
      target: { contentType: "task" as const, taskId: task.config.id },
    })),
    ...servers.map((server) => ({
      id: `server:${server.config.id}`,
      kind: "server" as const,
      label: server.config.name,
      description: trimDirectory(server.config.repositoriesBasePath ?? undefined),
      target: { contentType: "server" as const, serverId: server.config.id },
    })),
    ...chats.map((chat) => ({
      id: `chat:${chat.config.id}`,
      kind: "chat" as const,
      label: chat.config.name,
      description: getChatCodeExplorerRootDirectory(chat),
      target: { contentType: "chat" as const, chatId: chat.config.id },
    })),
  ];
}

export function getCodeExplorerOptionGroups(options: CodeExplorerOption[]): CodeExplorerOptionGroup[] {
  return CODE_EXPLORER_OPTION_GROUP_ORDER.map((kind) => ({
    kind,
    label: CODE_EXPLORER_OPTION_GROUP_LABELS[kind],
    options: options.filter((option) => option.kind === kind),
  })).filter((group) => group.options.length > 0);
}

export function resolveCodeExplorerTarget({
  target,
  workspaces,
  tasks,
  chats,
  servers,
  sessions,
  sessionsByServerId,
  createSession,
  createStandaloneSession,
}: ResolveCodeExplorerTargetArgs): ResolvedCodeExplorerTarget | null {
  if (!target) {
    return null;
  }

  const routeTargetId = getCodeExplorerTargetId(target);

  switch (target.contentType) {
    case "workspace": {
      const workspace = workspaces.find((candidate) => candidate.id === routeTargetId);
      if (!workspace) {
        return null;
      }

      const defaultRootDirectory = trimDirectory(workspace.directory);
      const workspaceSessions = sessions.filter((session) => session.config.workspaceId === workspace.id);
      const hasTerminal = workspace.serverSettings.agent.transport === "ssh";

      return {
        routeTarget: target,
        title: `${workspace.name} code explorer`,
        description: workspace.directory,
        defaultRootDirectory,
        backLabel: "Back to workspace",
        backRoute: { view: "workspace", workspaceId: workspace.id },
        target: { type: "workspace", id: workspace.id, startDirectory: target.startDirectory },
        buildRoute: (startDirectory?: string) => ({
          view: "code-explorer",
          contentType: "workspace",
          workspaceId: workspace.id,
          startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
            ? startDirectory.trim()
            : undefined,
        }),
        sessions: workspaceSessions,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose an existing SSH session or create a new one."
          : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable.",
        terminalSelectLabel: "Select workspace SSH session",
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions) => await createSession({
          workspaceId: workspace.id,
          name: `${workspace.name} terminal`,
          connectionMode: "dtach",
          useTmux: options?.useTmux,
        }),
        canChooseTerminalTmux: hasTerminal,
        testIdPrefix: "workspace",
        initialFilePath: target.filePath,
      };
    }
    case "task": {
      const task = tasks.find((candidate) => candidate.config.id === routeTargetId);
      if (!task) {
        return null;
      }

      const workspace = workspaces.find((candidate) => candidate.id === task.config.workspaceId);
      if (!workspace) {
        return null;
      }

      const defaultRootDirectory = getTaskCodeExplorerRootDirectory(task);
      const effectiveStartDirectory = target.startDirectory ?? defaultRootDirectory;
      const taskSessions = sessions.filter((session) => session.config.taskId === task.config.id);
      const hasTerminal = workspace.serverSettings.agent.transport === "ssh" && supportsTaskTerminal(task, taskSessions);

      return {
        routeTarget: target,
        title: `${task.config.name} code explorer`,
        description: defaultRootDirectory,
        defaultRootDirectory,
        backLabel: "Back to task",
        backRoute: { view: "task", taskId: task.config.id },
        target: { type: "workspace", id: task.config.workspaceId, startDirectory: effectiveStartDirectory },
        buildRoute: (startDirectory?: string) => ({
          view: "code-explorer",
          contentType: "task",
          taskId: task.config.id,
          startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
            ? startDirectory.trim()
            : undefined,
        }),
        sessions: taskSessions,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose the task SSH session or open the task terminal."
          : "This task does not have a task-linked terminal yet. Start or reconnect the task SSH session from the info tab.",
        terminalSelectLabel: "Select task SSH session",
        onCreateTerminal: async () => await getOrCreateTaskSshSessionApi(task.config.id),
        canChooseTerminalTmux: false,
        testIdPrefix: "workspace",
        initialFilePath: target.filePath,
      };
    }
    case "server": {
      const server = servers.find((candidate) => candidate.config.id === routeTargetId);
      if (!server) {
        return null;
      }

      const defaultRootDirectory = trimDirectory(server.config.repositoriesBasePath ?? undefined);
      return {
        routeTarget: target,
        title: `${server.config.name} code explorer`,
        description: defaultRootDirectory,
        defaultRootDirectory,
        backLabel: "Back to server",
        backRoute: { view: "ssh-server", serverId: server.config.id },
        target: { type: "server", id: server.config.id, startDirectory: target.startDirectory },
        buildRoute: (startDirectory?: string) => ({
          view: "code-explorer",
          contentType: "server",
          serverId: server.config.id,
          startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
            ? startDirectory.trim()
            : undefined,
        }),
        sessions: sessionsByServerId[server.config.id] ?? [],
        hasTerminal: true,
        emptyTerminalMessage: "Choose an existing standalone SSH session or create a new one.",
        terminalSelectLabel: "Select standalone SSH session",
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions) => await createStandaloneSession(server.config.id, {
          name: `${server.config.name} terminal`,
          connectionMode: "dtach",
          useTmux: options?.useTmux,
        }),
        canChooseTerminalTmux: true,
        testIdPrefix: "server",
        credentialPromptName: server.config.name,
        initialFilePath: target.filePath,
      };
    }
    case "chat": {
      const chat = chats.find((candidate) => candidate.config.id === routeTargetId);
      if (!chat) {
        return null;
      }

      const workspace = workspaces.find((candidate) => candidate.id === chat.config.workspaceId);
      if (!workspace) {
        return null;
      }

      const defaultRootDirectory = getChatCodeExplorerRootDirectory(chat);
      const effectiveStartDirectory = target.startDirectory ?? defaultRootDirectory;
      const workspaceSessions = sessions.filter((session) => session.config.workspaceId === workspace.id);
      const hasTerminal = workspace.serverSettings.agent.transport === "ssh";

      return {
        routeTarget: target,
        title: `${chat.config.name} code explorer`,
        description: defaultRootDirectory,
        defaultRootDirectory,
        backLabel: "Back to chat",
        backRoute: { view: "chat", chatId: chat.config.id },
        target: { type: "workspace", id: workspace.id, startDirectory: effectiveStartDirectory },
        buildRoute: (startDirectory?: string) => ({
          view: "code-explorer",
          contentType: "chat",
          chatId: chat.config.id,
          startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
            ? startDirectory.trim()
            : undefined,
        }),
        sessions: workspaceSessions,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose an existing SSH session or create a new one."
          : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable.",
        terminalSelectLabel: "Select workspace SSH session",
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions) => await createSession({
          workspaceId: workspace.id,
          name: `${workspace.name} terminal`,
          connectionMode: "dtach",
          useTmux: options?.useTmux,
        }),
        canChooseTerminalTmux: hasTerminal,
        testIdPrefix: "workspace",
        initialFilePath: target.filePath,
      };
    }
  }
}
