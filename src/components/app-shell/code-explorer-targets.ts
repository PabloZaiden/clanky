import type {
  Chat,
  ExecutionHostDescriptor,
  Task,
  Workspace,
  WorkspaceTerminalSession,
} from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateTerminalSessionRequest } from "@/contracts";
import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import { getOrCreateTaskTerminalSessionApi } from "../../hooks/task-actions/terminal-actions";
import type { CodeExplorerTarget } from "./shell-types";

type ExplorerSession = SshServerSession | WorkspaceTerminalSession;
type CodeExplorerOptionKind = "workspace" | "task" | "server" | "chat";
type DirectExecutionHostDescriptor = ExecutionHostDescriptor & {
  ref: Extract<ExecutionHostDescriptor["ref"], { kind: "local" | "mesh" }>;
};

export interface CodeExplorerTerminalOptions {
  useTmux?: boolean;
}

export interface CodeExplorerOption {
  id: string;
  kind: CodeExplorerOptionKind;
  label: string;
  description: string;
  target: CodeExplorerTarget;
}

export interface CodeExplorerOptionGroup {
  kind: CodeExplorerOptionKind;
  label: string;
  options: CodeExplorerOption[];
}

const CODE_EXPLORER_OPTION_GROUP_ORDER: CodeExplorerOptionKind[] = [
  "workspace",
  "task",
  "server",
  "chat",
];

const CODE_EXPLORER_OPTION_GROUP_LABELS: Record<CodeExplorerOptionKind, string> = {
  workspace: "Workspaces",
  task: "Tasks",
  server: "Servers",
  chat: "Chats",
};

export interface ResolvedCodeExplorerTarget {
  routeTarget: CodeExplorerTarget;
  title: string;
  description: string;
  defaultRootDirectory: string;
  backLabel: string;
  backRoute: WebAppRoute;
  target:
    | { type: "workspace" | "server"; id: string; startDirectory?: string }
    | { type: "executionHost"; kind: "local" | "mesh"; id: string; startDirectory?: string };
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
  executionHosts: ExecutionHostDescriptor[];
  servers: SshServer[];
  terminalSessions: WorkspaceTerminalSession[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  createTerminalSession: (request: CreateTerminalSessionRequest) => Promise<WorkspaceTerminalSession>;
  createStandaloneSession?: (
    serverId: string,
    options?: { name?: string; connectionMode?: import("@/shared").TerminalConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
}

function trimDirectory(directory: string | null | undefined): string {
  return directory?.trim() || "/";
}

function isDirectExecutionHost(host: ExecutionHostDescriptor): host is DirectExecutionHostDescriptor {
  return host.ref.kind === "local" || host.ref.kind === "mesh";
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
    case "execution-host":
      return `${target.hostKind}:${target.hostId}`;
    case "chat":
      return target.chatId;
  }
}

function supportsTaskTerminal(task: Task, terminalSessions: WorkspaceTerminalSession[]): boolean {
  if (terminalSessions.some((session) => session.config.taskId === task.config.id)) {
    return true;
  }

  return task.config.useWorktree || Boolean(task.state.git?.worktreePath);
}

export function getCodeExplorerOptions({
  workspaces,
  tasks,
  chats,
  executionHosts,
  servers,
}: Pick<
  ResolveCodeExplorerTargetArgs,
  "workspaces" | "tasks" | "chats" | "executionHosts" | "servers"
>): CodeExplorerOption[] {
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
    ...executionHosts
      .filter(isDirectExecutionHost)
      .map((host) => ({
        id: `execution-host:${host.ref.kind}:${host.ref.nodeId}`,
        kind: "server" as const,
        label: host.name,
        description: host.repositoriesBasePath?.trim() || host.endpoint || "/",
        target: {
          contentType: "execution-host" as const,
          hostKind: host.ref.kind,
          hostId: host.ref.nodeId,
        },
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
  executionHosts,
  servers,
  terminalSessions,
  sessionsByServerId,
  createTerminalSession,
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
      const workspaceTerminals = terminalSessions.filter((terminal) => terminal.config.workspaceId === workspace.id);
      const hasTerminal = true;

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
        sessions: workspaceTerminals,
        hasTerminal,
        emptyTerminalMessage: "Choose an existing terminal session or create a new one.",
        terminalSelectLabel: "Select workspace terminal session",
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions) => await createTerminalSession({
          workspaceId: workspace.id,
          name: `${workspace.name} terminal`,
          connectionMode: "dtach",
          useTmux: options?.useTmux,
        }),
        canChooseTerminalTmux: true,
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
      const taskTerminals = terminalSessions.filter((terminal) => terminal.config.taskId === task.config.id);
      const hasTerminal = supportsTaskTerminal(task, taskTerminals);

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
        sessions: taskTerminals,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose the task terminal session or open the task terminal."
          : "This task does not have a task-linked terminal yet. Open the task terminal from the info tab.",
        terminalSelectLabel: "Select task terminal session",
        onCreateTerminal: async () => await getOrCreateTaskTerminalSessionApi(task.config.id),
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
      if (!createStandaloneSession) {
        throw new Error("Standalone SSH session creation is unavailable for server code explorer");
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
    case "execution-host": {
      const host = executionHosts.find((candidate) => (
        candidate.ref.kind !== "ssh"
        && candidate.ref.kind === target.hostKind
        && candidate.ref.nodeId === target.hostId
      )) as DirectExecutionHostDescriptor | undefined;
      if (!host) {
        return null;
      }

      const defaultRootDirectory = trimDirectory(host.repositoriesBasePath);
      const hostTerminals = terminalSessions.filter((terminal) => {
        const ref = terminal.config.executionHostBinding?.host;
        return ref?.kind === target.hostKind
          && ref.nodeId === target.hostId;
      });
      const hasTerminal = host.capabilities.interactiveTerminal !== undefined;

      return {
        routeTarget: target,
        title: `${host.name} code explorer`,
        description: defaultRootDirectory,
        defaultRootDirectory,
        backLabel: "Back to server",
        backRoute: {
          view: "execution-host",
          hostKind: target.hostKind,
          hostId: target.hostId,
        },
        target: {
          type: "executionHost",
          kind: target.hostKind,
          id: target.hostId,
          startDirectory: target.startDirectory,
        },
        buildRoute: (startDirectory?: string) => ({
          view: "code-explorer",
          contentType: "execution-host",
          hostKind: target.hostKind,
          hostId: target.hostId,
          startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
            ? startDirectory.trim()
            : undefined,
        }),
        sessions: hostTerminals,
        hasTerminal,
        emptyTerminalMessage: "Create a terminal on this server to open it beside the files.",
        terminalSelectLabel: "Server terminal",
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions) => await createTerminalSession({
          executionHost: host.ref,
          name: `${host.name} terminal`,
          directory: target.startDirectory ?? defaultRootDirectory,
          connectionMode: "direct",
          useTmux: options?.useTmux,
        }),
        canChooseTerminalTmux: true,
        testIdPrefix: "server",
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
      const workspaceTerminals = terminalSessions.filter((terminal) => terminal.config.workspaceId === workspace.id);
      const hasTerminal = true;

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
        sessions: workspaceTerminals,
        hasTerminal,
        emptyTerminalMessage: "Choose an existing terminal session or create a new one.",
        terminalSelectLabel: "Select workspace terminal session",
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions) => await createTerminalSession({
          workspaceId: workspace.id,
          name: `${workspace.name} terminal`,
          connectionMode: "dtach",
          useTmux: options?.useTmux,
        }),
        canChooseTerminalTmux: true,
        testIdPrefix: "workspace",
        initialFilePath: target.filePath,
      };
    }
  }
}
