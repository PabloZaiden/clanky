import { useEffect, type ReactNode } from "react";
import {
  ErrorState,
  LoadingState,
  Page,
  useCurrentUser,
  type WebAppRootProps,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type {
  Agent,
  Chat,
  ExecutionHostDescriptor,
  Task,
  SshServer,
  TerminalSession,
  Workspace,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { StandaloneChatTranscriptViewer } from "../StandaloneChatTranscriptViewer";
import { AppRouteContent, type ShellMainContentProps } from "./shell-main-content";
import { getRouteString } from "./route-fields";

const ROUTE_VIEWS = [
  "home",
  "trash",
  "agents",
  "agent",
  "agent-run",
  "code-explorer",
  "scratchpad",
  "task",
  "task-files",
  "chat",
  "chat-transcript",
  "terminal",
  "workspace",
  "workspace-files",
  "workspace-previews",
  "workspace-settings",
  "execution-host",
  "execution-host-files",
  "provisioning-job",
  "worker-update-job",
  "compose",
  "rebuild-workspace",
  "restart-workspace",
] as const;

const WORKSPACE_ENTITY_ROUTE_VIEWS = new Set([
  "workspace",
  "workspace-files",
  "workspace-previews",
  "workspace-settings",
  "scratchpad",
  "rebuild-workspace",
  "restart-workspace",
]);

export interface ShellRouteSelection {
  taskId: string | undefined;
  chatId: string | undefined;
  composeKind: string | undefined;
  selectedTask: Task | null;
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  composeExecutionHost: ExecutionHostDescriptor | null;
  selectedAgent: Agent | null;
}

type ShellRouteContentSelection = Pick<
  ShellRouteSelection,
  | "selectedTask"
  | "selectedChat"
  | "selectedWorkspace"
  | "composeWorkspace"
  | "composeServer"
  | "composeExecutionHost"
>;

export type ShellRouteCompositionContext = Omit<
  ShellMainContentProps,
  "route" | keyof ShellRouteContentSelection
>;

interface ShellRouteSelectionData {
  tasks: Task[];
  chats: Chat[];
  workspaces: Workspace[];
  servers: SshServer[];
  executionHosts: ExecutionHostDescriptor[];
  agents: Agent[];
}

interface ShellRouteEntityCollection<T> {
  items: T[];
  loading: boolean;
  error: string | null;
}

interface ShellRouteEntityResources {
  chats: ShellRouteEntityCollection<Chat>;
  workspaces: ShellRouteEntityCollection<Workspace>;
  servers: ShellRouteEntityCollection<SshServer>;
  executionHosts: ShellRouteEntityCollection<ExecutionHostDescriptor>;
  agents: ShellRouteEntityCollection<Agent>;
  terminalSessions: ShellRouteEntityCollection<TerminalSession>;
}

function isMissingFromCollection<T>(
  id: string | undefined,
  collection: ShellRouteEntityCollection<T>,
  getId: (item: T) => string,
): boolean {
  if (id && decodeCollaborationResourceReference(id)) return false;
  return Boolean(id)
    && !collection.loading
    && collection.error === null
    && !collection.items.some((item) => getId(item) === id);
}

export function getShellRouteTaskId(route: WebAppRoute): string | undefined {
  const codeExplorerType = route.view === "code-explorer"
    ? getRouteString(route, "contentType")
    : undefined;
  if (route.view === "task" || route.view === "task-files" || codeExplorerType === "task") {
    return getRouteString(route, "taskId");
  }
  return undefined;
}

export function isMissingShellRouteTarget(
  route: WebAppRoute,
  resources: ShellRouteEntityResources,
): boolean {
  const codeExplorerType = route.view === "code-explorer"
    ? getRouteString(route, "contentType")
    : undefined;
  const chatId = route.view === "chat"
    ? getRouteString(route, "chatId")
    : codeExplorerType === "chat"
      ? getRouteString(route, "chatId")
      : undefined;
  if (isMissingFromCollection(chatId, resources.chats, (chat) => chat.config.id)) {
    return true;
  }

  const workspaceId = WORKSPACE_ENTITY_ROUTE_VIEWS.has(route.view)
    ? getRouteString(route, "workspaceId")
    : codeExplorerType === "workspace"
      ? getRouteString(route, "workspaceId")
      : undefined;
  if (isMissingFromCollection(workspaceId, resources.workspaces, (workspace) => workspace.id)) {
    return true;
  }

  const agentId = route.view === "agent" || route.view === "agent-run"
    ? getRouteString(route, "agentId")
    : undefined;
  if (isMissingFromCollection(agentId, resources.agents, (agent) => agent.config.id)) {
    return true;
  }

  const terminalSessionId = route.view === "terminal"
    ? getRouteString(route, "terminalSessionId")
    : undefined;
  if (isMissingFromCollection(
    terminalSessionId,
    resources.terminalSessions,
    (session) => session.config.id,
  )) {
    return true;
  }

  const executionHostRoute = route.view === "execution-host"
    || route.view === "execution-host-files"
    || codeExplorerType === "execution-host"
    || (route.view === "compose"
      && ["execution-host-chat", "execution-host-terminal"].includes(
        getRouteString(route, "kind") ?? "",
      ));
  if (executionHostRoute) {
    const hostKind = getRouteString(route, "hostKind");
    const hostId = getRouteString(route, "hostId");
    if (
      hostKind
      && hostId
      && ["local", "mesh", "ssh"].includes(hostKind)
      && isMissingFromCollection(
        hostId,
        resources.executionHosts,
        (host) => host.ref.kind === hostKind
          ? getExecutionHostSourceId(host.ref)
          : "",
      )
    ) {
      return true;
    }
  }

  if (route.view === "compose" && getRouteString(route, "kind") === "ssh-server") {
    const serverId = getRouteString(route, "serverId") ?? getRouteString(route, "scopeId");
    if (isMissingFromCollection(serverId, resources.servers, (server) => server.config.id)) {
      return true;
    }
  }

  return false;
}

export function getShellRouteSelection(
  route: WebAppRoute,
  {
    tasks,
    chats,
    workspaces,
    servers,
    executionHosts,
    agents,
  }: ShellRouteSelectionData,
): ShellRouteSelection {
  const codeExplorerContentType = route.view === "code-explorer" ? route["contentType"] : undefined;
  const codeExplorerTaskId = codeExplorerContentType === "task"
    ? getRouteString(route, "taskId") ?? null
    : null;
  const codeExplorerChatId = codeExplorerContentType === "chat"
    ? getRouteString(route, "chatId") ?? null
    : null;
  const codeExplorerWorkspaceId = codeExplorerContentType === "workspace"
    ? getRouteString(route, "workspaceId") ?? null
    : null;
  const taskId = getRouteString(route, "taskId");
  const chatId = getRouteString(route, "chatId");
  const workspaceId = getRouteString(route, "workspaceId");
  const serverId = getRouteString(route, "serverId");
  const composeKind = route.view === "compose" ? getRouteString(route, "kind") : undefined;
  const composeScopeId = route.view === "compose" ? getRouteString(route, "scopeId") : undefined;
  const isExecutionHostCompose = composeKind === "execution-host-chat"
    || composeKind === "execution-host-terminal";

  const selectedTask =
    route.view === "task" || route.view === "task-files"
      ? (taskId ? (tasks.find((task) => task.config.id === taskId) ?? null) : null)
      : codeExplorerTaskId
        ? (tasks.find((task) => task.config.id === codeExplorerTaskId) ?? null)
        : null;
  const selectedChat =
    route.view === "chat" || route.view === "chat-transcript"
      ? (chatId ? (chats.find((chat) => chat.config.id === chatId) ?? null) : null)
      : codeExplorerChatId
        ? (chats.find((chat) => chat.config.id === codeExplorerChatId) ?? null)
        : null;
  const selectedWorkspace =
    route.view === "workspace"
      || route.view === "workspace-files"
      || route.view === "workspace-previews"
      || route.view === "workspace-settings"
      || route.view === "scratchpad"
      || route.view === "rebuild-workspace"
      || route.view === "restart-workspace"
      ? (workspaceId ? (workspaces.find((workspace) => workspace.id === workspaceId) ?? null) : null)
      : codeExplorerWorkspaceId
        ? (workspaces.find((workspace) => workspace.id === codeExplorerWorkspaceId) ?? null)
        : codeExplorerTaskId
          ? (workspaces.find((workspace) => workspace.id === selectedTask?.config.workspaceId) ?? null)
          : codeExplorerChatId
            ? (workspaces.find((workspace) => workspace.id === selectedChat?.config.workspaceId) ?? null)
            : null;
  const composeWorkspace =
    route.view === "compose"
      && composeKind !== "ssh-server"
      && !isExecutionHostCompose
      ? (workspaces.find((workspace) => workspace.id === (workspaceId ?? composeScopeId)) ?? null)
      : null;
  const composeServer =
    route.view === "compose"
      && composeKind === "ssh-server"
      ? (servers.find((server) => server.config.id === (serverId ?? composeScopeId)) ?? null)
      : null;
  const composeExecutionHost =
    route.view === "compose" && isExecutionHostCompose
      ? (executionHosts.find((host) => {
          const hostId = getExecutionHostSourceId(host.ref);
          return host.ref.kind === getRouteString(route, "hostKind")
            && hostId === getRouteString(route, "hostId");
        }) ?? null)
      : null;
  const selectedAgentId = route.view === "agent" || route.view === "agent-run"
    ? getRouteString(route, "agentId") ?? null
    : null;
  const selectedAgent = selectedAgentId
    ? (agents.find((agent) => agent.config.id === selectedAgentId) ?? null)
    : null;

  return {
    taskId,
    chatId,
    composeKind,
    selectedTask,
    selectedChat,
    selectedWorkspace,
    composeWorkspace,
    composeServer,
    composeExecutionHost,
    selectedAgent,
  };
}

function renderShellRouteContent(
  route: WebAppRoute,
  context: ShellRouteCompositionContext,
): ReactNode {
  if (route.view === "chat-transcript") {
    const transcriptChatId = getRouteString(route, "chatId");
    return (
      <Page layout="full" className="standalone-transcript-page">
        {context.missingRouteTarget
          ? <LoadingState title="Returning home" />
          : transcriptChatId
            ? (
              <StandaloneChatTranscriptViewer
                chatId={transcriptChatId}
                onMissingEntity={() => context.navigateWithinShell({ view: "home" })}
              />
            )
          : (
            <ErrorState
              title="Chat transcript not found"
              description="The transcript route is missing a chat identifier."
            />
          )}
      </Page>
    );
  }

  const selection = getShellRouteSelection(route, {
    tasks: context.tasks,
    chats: context.chats,
    workspaces: context.workspaces,
    servers: context.servers,
    executionHosts: context.executionHosts,
    agents: context.agents.agents,
  });

  return (
    <AppRouteContent
      {...context}
      route={route}
      selectedTask={selection.selectedTask}
      selectedChat={selection.selectedChat}
      selectedWorkspace={selection.selectedWorkspace}
      composeWorkspace={selection.composeWorkspace}
      composeServer={selection.composeServer}
      composeExecutionHost={selection.composeExecutionHost}
    />
  );
}

export function buildShellRoutes(
  context: ShellRouteCompositionContext,
): WebAppRootProps["routes"] {
  const renderRouteContent = (route: WebAppRoute) => renderShellRouteContent(route, context);
  return Object.fromEntries(
    ROUTE_VIEWS.map((view) => [view, renderRouteContent]),
  ) as WebAppRootProps["routes"];
}

export function CurrentUserObserver({
  onOwnerChange,
}: {
  onOwnerChange: (isOwner: boolean) => void;
}) {
  const isOwner = useCurrentUser()?.isOwner === true;
  useEffect(() => {
    onOwnerChange(isOwner);
    return () => onOwnerChange(false);
  }, [isOwner, onOwnerChange]);
  return null;
}
