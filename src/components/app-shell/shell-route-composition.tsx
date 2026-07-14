import type { ReactNode } from "react";
import { ErrorState, Page, type WebAppRootProps, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Agent, Chat, Task, SshServer, Workspace } from "@/shared";
import { StandaloneChatTranscriptViewer } from "../StandaloneChatTranscriptViewer";
import { AppRouteContent, type ShellMainContentProps } from "./shell-main-content";
import { getRouteString } from "./route-fields";

const ROUTE_VIEWS = [
  "home",
  "agents",
  "agent",
  "agent-run",
  "code-explorer",
  "task",
  "task-files",
  "chat",
  "chat-transcript",
  "ssh",
  "workspace",
  "workspace-files",
  "workspace-previews",
  "workspace-settings",
  "ssh-server",
  "vnc-session",
  "ssh-server-settings",
  "server-files",
  "server-arise",
  "compose",
  "rebuild-workspace",
  "restart-workspace",
] as const;

export interface ShellRouteSelection {
  taskId: string | undefined;
  chatId: string | undefined;
  composeKind: string | undefined;
  selectedTask: Task | null;
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  composeServerSessionCount: number;
  selectedServer: SshServer | null;
  selectedAgent: Agent | null;
}

type ShellRouteContentSelection = Pick<
  ShellRouteSelection,
  | "selectedTask"
  | "selectedChat"
  | "selectedWorkspace"
  | "composeWorkspace"
  | "composeServer"
  | "composeServerSessionCount"
  | "selectedServer"
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
  sessionsByServerId: Record<string, import("@/shared/ssh-server").SshServerSession[]>;
  agents: Agent[];
}

export function getShellRouteSelection(
  route: WebAppRoute,
  {
    tasks,
    chats,
    workspaces,
    servers,
    sessionsByServerId,
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
  const codeExplorerServerId = codeExplorerContentType === "server"
    ? getRouteString(route, "serverId") ?? null
    : null;
  const taskId = getRouteString(route, "taskId");
  const chatId = getRouteString(route, "chatId");
  const workspaceId = getRouteString(route, "workspaceId");
  const serverId = getRouteString(route, "serverId");
  const composeKind = route.view === "compose" ? getRouteString(route, "kind") : undefined;
  const composeScopeId = route.view === "compose" ? getRouteString(route, "scopeId") : undefined;

  const selectedTask =
    route.view === "task" || route.view === "task-files"
      ? (taskId ? (tasks.find((task) => task.config.id === taskId) ?? null) : null)
      : codeExplorerTaskId
        ? (tasks.find((task) => task.config.id === codeExplorerTaskId) ?? null)
        : null;
  const selectedChat =
    route.view === "chat"
      ? (chatId ? (chats.find((chat) => chat.config.id === chatId) ?? null) : null)
      : codeExplorerChatId
        ? (chats.find((chat) => chat.config.id === codeExplorerChatId) ?? null)
        : null;
  const selectedWorkspace =
    route.view === "workspace"
      || route.view === "workspace-files"
      || route.view === "workspace-previews"
      || route.view === "workspace-settings"
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
    route.view === "compose" && composeKind !== "ssh-server" && composeKind !== "ssh-server-chat"
      ? (workspaces.find((workspace) => workspace.id === (workspaceId ?? composeScopeId)) ?? null)
      : null;
  const composeServer =
    route.view === "compose"
      && (composeKind === "ssh-session" || composeKind === "ssh-server" || composeKind === "ssh-server-chat")
      ? (servers.find((server) => server.config.id === (serverId ?? composeScopeId)) ?? null)
      : null;
  const composeServerSessionCount = composeServer
    ? (sessionsByServerId[composeServer.config.id]?.length ?? 0)
    : 0;
  const selectedServer =
    route.view === "ssh-server"
      || route.view === "vnc-session"
      || route.view === "ssh-server-settings"
      || route.view === "server-files"
      || route.view === "server-arise"
      ? (serverId ? (servers.find((server) => server.config.id === serverId) ?? null) : null)
      : codeExplorerServerId
        ? (servers.find((server) => server.config.id === codeExplorerServerId) ?? null)
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
    composeServerSessionCount,
    selectedServer,
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
      <Page layout="full">
        {transcriptChatId
          ? <StandaloneChatTranscriptViewer chatId={transcriptChatId} />
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
    sessionsByServerId: context.sessionsByServerId,
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
      composeServerSessionCount={selection.composeServerSessionCount}
      selectedServer={selection.selectedServer}
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
