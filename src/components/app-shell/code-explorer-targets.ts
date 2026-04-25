import type { Chat, CreateSshSessionRequest, Loop, SshConnectionMode, SshSession, Workspace } from "../../types";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import { getOrCreateLoopSshSessionApi } from "../../hooks/loop-actions/ssh-actions";
import type { CodeExplorerTarget, ShellRoute } from "./shell-types";

type ExplorerSession = SshSession | SshServerSession;

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
  "loop",
  "server",
  "chat",
];

const CODE_EXPLORER_OPTION_GROUP_LABELS: Record<CodeExplorerTarget["contentType"], string> = {
  workspace: "Workspaces",
  loop: "Loops",
  server: "SSH servers",
  chat: "Chats",
};

export interface ResolvedCodeExplorerTarget {
  routeTarget: CodeExplorerTarget;
  title: string;
  description: string;
  defaultRootDirectory: string;
  backLabel: string;
  backRoute: ShellRoute;
  target: { type: "workspace" | "server"; id: string; startDirectory?: string };
  buildRoute: (startDirectory?: string) => ShellRoute;
  sessions: ExplorerSession[];
  hasTerminal: boolean;
  emptyTerminalMessage: string;
  terminalSelectLabel: string;
  onCreateTerminal: () => Promise<ExplorerSession>;
  testIdPrefix: "workspace" | "server";
  credentialPromptName?: string;
}

interface ResolveCodeExplorerTargetArgs {
  target?: CodeExplorerTarget;
  workspaces: Workspace[];
  loops: Loop[];
  chats: Chat[];
  servers: SshServer[];
  sessions: SshSession[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode },
  ) => Promise<SshServerSession>;
}

function trimDirectory(directory: string | undefined): string {
  return directory?.trim() || "/";
}

export function getLoopCodeExplorerRootDirectory(loop: Loop): string {
  return trimDirectory(loop.state.git?.worktreePath || loop.config.directory);
}

export function getChatCodeExplorerRootDirectory(chat: Chat): string {
  return trimDirectory(chat.state.worktree?.worktreePath || chat.config.directory);
}

function getRouteTargetId(target: CodeExplorerTarget): string {
  switch (target.contentType) {
    case "workspace":
      return target.workspaceId;
    case "loop":
      return target.loopId;
    case "server":
      return target.serverId;
    case "chat":
      return target.chatId;
  }
}

function supportsLoopTerminal(loop: Loop, sessions: SshSession[]): boolean {
  if (sessions.some((session) => session.config.loopId === loop.config.id)) {
    return true;
  }

  return loop.config.useWorktree || Boolean(loop.state.git?.worktreePath);
}

export function getCodeExplorerOptions({
  workspaces,
  loops,
  chats,
  servers,
}: Pick<ResolveCodeExplorerTargetArgs, "workspaces" | "loops" | "chats" | "servers">): CodeExplorerOption[] {
  return [
    ...workspaces.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      kind: "workspace" as const,
      label: workspace.name,
      description: workspace.directory,
      target: { contentType: "workspace" as const, workspaceId: workspace.id },
    })),
    ...loops.map((loop) => ({
      id: `loop:${loop.config.id}`,
      kind: "loop" as const,
      label: loop.config.name,
      description: getLoopCodeExplorerRootDirectory(loop),
      target: { contentType: "loop" as const, loopId: loop.config.id },
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
  loops,
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

  const routeTargetId = getRouteTargetId(target);

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
          target: {
            contentType: "workspace",
            workspaceId: workspace.id,
            startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
              ? startDirectory.trim()
              : undefined,
          },
        }),
        sessions: workspaceSessions,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose an existing SSH session or create a new one."
          : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable.",
        terminalSelectLabel: "Select workspace SSH session",
        onCreateTerminal: async () => await createSession({
          workspaceId: workspace.id,
          name: `${workspace.name} terminal`,
          connectionMode: "dtach",
        }),
        testIdPrefix: "workspace",
      };
    }
    case "loop": {
      const loop = loops.find((candidate) => candidate.config.id === routeTargetId);
      if (!loop) {
        return null;
      }

      const workspace = workspaces.find((candidate) => candidate.id === loop.config.workspaceId);
      if (!workspace) {
        return null;
      }

      const defaultRootDirectory = getLoopCodeExplorerRootDirectory(loop);
      const effectiveStartDirectory = target.startDirectory ?? defaultRootDirectory;
      const loopSessions = sessions.filter((session) => session.config.loopId === loop.config.id);
      const hasTerminal = workspace.serverSettings.agent.transport === "ssh" && supportsLoopTerminal(loop, loopSessions);

      return {
        routeTarget: target,
        title: `${loop.config.name} code explorer`,
        description: defaultRootDirectory,
        defaultRootDirectory,
        backLabel: "Back to loop",
        backRoute: { view: "loop", loopId: loop.config.id },
        target: { type: "workspace", id: loop.config.workspaceId, startDirectory: effectiveStartDirectory },
        buildRoute: (startDirectory?: string) => ({
          view: "code-explorer",
          target: {
            contentType: "loop",
            loopId: loop.config.id,
            startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
              ? startDirectory.trim()
              : undefined,
          },
        }),
        sessions: loopSessions,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose the loop SSH session or open the loop terminal."
          : "This loop does not have a loop-linked terminal yet. Start or reconnect the loop SSH session from the info tab.",
        terminalSelectLabel: "Select loop SSH session",
        onCreateTerminal: async () => await getOrCreateLoopSshSessionApi(loop.config.id),
        testIdPrefix: "workspace",
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
          target: {
            contentType: "server",
            serverId: server.config.id,
            startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
              ? startDirectory.trim()
              : undefined,
          },
        }),
        sessions: sessionsByServerId[server.config.id] ?? [],
        hasTerminal: true,
        emptyTerminalMessage: "Choose an existing standalone SSH session or create a new one.",
        terminalSelectLabel: "Select standalone SSH session",
        onCreateTerminal: async () => await createStandaloneSession(server.config.id, {
          name: `${server.config.name} terminal`,
          connectionMode: "dtach",
        }),
        testIdPrefix: "server",
        credentialPromptName: server.config.name,
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
          target: {
            contentType: "chat",
            chatId: chat.config.id,
            startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
              ? startDirectory.trim()
              : undefined,
          },
        }),
        sessions: workspaceSessions,
        hasTerminal,
        emptyTerminalMessage: hasTerminal
          ? "Choose an existing SSH session or create a new one."
          : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable.",
        terminalSelectLabel: "Select workspace SSH session",
        onCreateTerminal: async () => await createSession({
          workspaceId: workspace.id,
          name: `${workspace.name} terminal`,
          connectionMode: "dtach",
        }),
        testIdPrefix: "workspace",
      };
    }
  }
}
