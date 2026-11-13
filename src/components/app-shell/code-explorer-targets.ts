import type {
  Chat,
  ExecutionHostDescriptor,
  Workspace,
  TerminalSession,
} from "@/shared";
import {
  getExecutionHostSourceId,
  supportsExecutionHostCapability,
} from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateTerminalSessionRequest } from "@/contracts";
import type { CodeExplorerTarget } from "./shell-types";
import { getWorkspaceDisplayName } from "../../lib/workspace-label";

type ExplorerSession = TerminalSession;
type CodeExplorerOptionKind = "workspace" | "server" | "chat";

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
  "server",
  "chat",
];

const CODE_EXPLORER_OPTION_GROUP_LABELS: Record<CodeExplorerOptionKind, string> = {
  workspace: "Workspaces",
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
    | { type: "workspace"; id: string; startDirectory?: string }
    | { type: "executionHost"; kind: "local" | "mesh"; id: string; startDirectory?: string };
  buildRoute: (startDirectory?: string) => WebAppRoute;
  sessions: ExplorerSession[];
  hasTerminal: boolean;
  emptyTerminalMessage: string;
  terminalSelectLabel: string;
  onCreateTerminal: (
    options?: CodeExplorerTerminalOptions,
    startDirectory?: string,
  ) => Promise<ExplorerSession>;
  canChooseTerminalTmux: boolean;
  testIdPrefix: "workspace" | "server";
  initialFilePath?: string;
}

interface ResolveCodeExplorerTargetArgs {
  target?: CodeExplorerTarget;
  workspaces: Workspace[];
  chats: Chat[];
  executionHosts: ExecutionHostDescriptor[];
  terminalSessions: TerminalSession[];
  createTerminalSession: (request: CreateTerminalSessionRequest) => Promise<TerminalSession>;
}

function trimDirectory(directory: string | null | undefined): string {
  return directory?.trim() || "/";
}

export function getChatCodeExplorerRootDirectory(chat: Chat): string {
  return trimDirectory(chat.state.worktree?.worktreePath || chat.config.directory);
}

export function getCodeExplorerTargetId(target: CodeExplorerTarget): string {
  switch (target.contentType) {
    case "workspace":
      return target.workspaceId;
    case "execution-host":
      return `${target.hostKind}:${target.hostId}`;
    case "chat":
      return target.chatId;
  }
}

export function getCodeExplorerOptions({
  workspaces,
  chats,
  executionHosts,
}: Pick<
  ResolveCodeExplorerTargetArgs,
  "workspaces" | "chats" | "executionHosts"
>): CodeExplorerOption[] {
  return [
    ...workspaces.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      kind: "workspace" as const,
      label: getWorkspaceDisplayName(workspace),
      description: workspace.directory,
      target: { contentType: "workspace" as const, workspaceId: workspace.id },
    })),
    ...executionHosts
      .filter((host) => supportsExecutionHostCapability(
        host.capabilities,
        "fileOperations",
      ))
      .map((host) => {
        const hostId = getExecutionHostSourceId(host.ref);
        return {
          id: `execution-host:${host.ref.kind}:${hostId}`,
          kind: "server" as const,
          label: host.name,
          description: host.repositoriesBasePath?.trim() || host.endpoint || "/",
          target: {
            contentType: "execution-host" as const,
            hostKind: host.ref.kind,
            hostId,
          },
        };
      }),
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
  chats,
  executionHosts,
  terminalSessions,
  createTerminalSession,
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
        title: `${getWorkspaceDisplayName(workspace)} code explorer`,
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
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions, startDirectory?: string) => (
          await createTerminalSession({
            workspaceId: workspace.id,
            name: `${workspace.name} terminal`,
            directory: startDirectory?.trim() || defaultRootDirectory,
            connectionMode: "dtach",
            useTmux: options?.useTmux,
          })
        ),
        canChooseTerminalTmux: true,
        testIdPrefix: "workspace",
        initialFilePath: target.filePath,
      };
    }
    case "execution-host": {
      const host = executionHosts.find((candidate) => (
        candidate.ref.kind === target.hostKind
        && getExecutionHostSourceId(candidate.ref) === target.hostId
      ));
      if (
        !host
        || !supportsExecutionHostCapability(
          host.capabilities,
          "fileOperations",
        )
      ) {
        return null;
      }

      const defaultRootDirectory = trimDirectory(host.repositoriesBasePath);
      const hostTerminals = terminalSessions.filter((terminal) => {
        const ref = terminal.config.executionHostBinding.host;
        return ref?.kind === target.hostKind
          && getExecutionHostSourceId(ref) === target.hostId;
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
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions, startDirectory?: string) => (
          await createTerminalSession({
            executionHost: host.ref,
            name: `${host.name} terminal`,
            directory: startDirectory?.trim() || target.startDirectory || defaultRootDirectory,
            connectionMode: "dtach",
            useTmux: options?.useTmux,
          })
        ),
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

      const source = chat.config.source;
      if (source?.kind === "execution_host") {
        const host = executionHosts.find((candidate) => (
          candidate.targetKey === source.executionHost.targetKey
        ));
        if (!host) {
          return null;
        }
        const hostId = getExecutionHostSourceId(host.ref);
        const defaultRootDirectory = getChatCodeExplorerRootDirectory(chat);
        const hostTerminals = terminalSessions.filter((terminal) => (
          !terminal.config.workspaceId
          && terminal.config.executionHostBinding.targetKey === host.targetKey
        ));
        return {
          routeTarget: target,
          title: `${chat.config.name} code explorer`,
          description: defaultRootDirectory,
          defaultRootDirectory,
          backLabel: "Back to chat",
          backRoute: { view: "chat", chatId: chat.config.id },
          target: {
            type: "executionHost",
            kind: host.ref.kind,
            id: hostId,
            startDirectory: target.startDirectory ?? defaultRootDirectory,
          },
          buildRoute: (startDirectory?: string) => ({
            view: "code-explorer",
            contentType: "chat",
            chatId: chat.config.id,
            startDirectory: startDirectory?.trim() && startDirectory.trim() !== defaultRootDirectory
              ? startDirectory.trim()
              : undefined,
          }),
          sessions: hostTerminals,
          hasTerminal: host.capabilities.interactiveTerminal !== undefined,
          emptyTerminalMessage: "Create a terminal on this server to open it beside the files.",
          terminalSelectLabel: "Server terminal",
          onCreateTerminal: async (options?: CodeExplorerTerminalOptions, startDirectory?: string) => (
            await createTerminalSession({
              executionHost: host.ref,
              name: `${host.name} terminal`,
              directory: startDirectory?.trim() || target.startDirectory || defaultRootDirectory,
              connectionMode: "dtach",
              useTmux: options?.useTmux,
            })
          ),
          canChooseTerminalTmux: true,
          testIdPrefix: "server",
          initialFilePath: target.filePath,
        };
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
        onCreateTerminal: async (options?: CodeExplorerTerminalOptions, startDirectory?: string) => (
          await createTerminalSession({
            workspaceId: workspace.id,
            name: `${workspace.name} terminal`,
            directory: startDirectory?.trim() || defaultRootDirectory,
            connectionMode: "dtach",
            useTmux: options?.useTmux,
          })
        ),
        canChooseTerminalTmux: true,
        testIdPrefix: "workspace",
        initialFilePath: target.filePath,
      };
    }
  }
}
