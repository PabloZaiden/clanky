import { useMemo, type ReactNode } from "react";
import {
  type ActionMenuItem,
  type SidebarNode,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { ShellDialogComposition } from "./shell-dialog-composition";
import type { UseComposeStateResult } from "./use-compose-state";
import {
  getChatCodeExplorerRootDirectory,
  getTaskCodeExplorerRootDirectory,
} from "./code-explorer-targets";
import { getProvisioningReturnRoute, getRouteString } from "./route-fields";
import {
  getHeaderOwnerRoute,
  sidebarNodeMatchesRoute,
} from "./shell-sidebar-composition";
import { HOME_ROUTE } from "./use-shell-navigation";
import type {
  Agent,
  Chat,
  ExecutionHostDescriptor,
  SshServer,
  SshServerSession,
  Task,
  Workspace,
} from "@/shared";
import { findRegisteredSshServer } from "@/shared";
import { Badge, Button, formatStatusLabel, getAgentStatusBadgeVariant, StatusBadge } from "../common";

export interface HeaderModel {
  title?: string;
  scopeSubtitle?: string;
  detailSubtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
  badgeIsStatus?: boolean;
  detailSubtitleMobileHidden?: boolean;
}

type HeaderNodeModel = HeaderModel & {
  nodeSubtitle?: string;
};

export interface RegisteredHeaderActions {
  owner: symbol;
  actions: ReactNode;
}

interface UseShellHeaderOptions {
  route: WebAppRoute;
  headerNodes: SidebarNode[];
  registeredHeaderActions: RegisteredHeaderActions | null;
  navigateWithinShell: (route: WebAppRoute) => void;
  taskId: string | undefined;
  chatId: string | undefined;
  composeKind: string | undefined;
  selectedTask: Task | null;
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  composeExecutionHost: ExecutionHostDescriptor | null;
  selectedServer: SshServer | null;
  selectedAgent: Agent | null;
  tasksLoading: boolean;
  chatsLoading: boolean;
  agents: UseAgentsResult;
  servers: SshServer[];
  terminalSessions: import("@/shared").WorkspaceTerminalSession[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  workspaces: Workspace[];
  editingAgentId: ShellDialogComposition["editingAgentId"];
  composeActionState: UseComposeStateResult["composeActionState"];
}

export function RouteHeaderTitle({ model, defaultTitle }: { model: HeaderModel; defaultTitle: string }) {
  const statusBadge = model.badgeIsStatus === false ? undefined : model.badge;
  const metadataBadge = model.badgeIsStatus === false ? model.badge : undefined;

  return (
    <span className="flex min-w-0 max-w-full flex-1 flex-col items-start overflow-hidden whitespace-normal">
      {model.scopeSubtitle || statusBadge ? (
        <span className="flex max-w-full min-w-0 items-center gap-1.5">
          {model.scopeSubtitle ? (
            <span className="min-w-0 truncate text-[11px] font-normal leading-4 text-gray-500 dark:text-gray-400">
              {model.scopeSubtitle}
            </span>
          ) : null}
          {statusBadge ? (
            <StatusBadge variant={model.badgeVariant} size="sm" className="shrink-0">
              {statusBadge}
            </StatusBadge>
          ) : null}
        </span>
      ) : null}
      <span className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
        <span className="min-w-0 flex-shrink truncate whitespace-nowrap text-lg font-bold text-gray-900 dark:text-gray-100">
          {model.title ?? defaultTitle}
        </span>
        {metadataBadge ? (
          <Badge variant={model.badgeVariant} size="sm" className="shrink-0">
            {metadataBadge}
          </Badge>
        ) : null}
        {model.detailSubtitle ? (
          <span className={`min-w-0 flex-shrink truncate whitespace-nowrap text-xs font-normal text-gray-500 dark:text-gray-400 ${model.detailSubtitleMobileHidden ? "hidden sm:inline" : ""}`}>
            {model.detailSubtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function getWorkspaceScopeSubtitle(workspaceId: string | undefined, workspaces: Workspace[]): string | undefined {
  if (!workspaceId) {
    return undefined;
  }
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return undefined;
  }
  return workspace.name;
}

function getServerName(serverId: string | undefined, servers: SshServer[]): string | undefined {
  if (!serverId) {
    return undefined;
  }
  return servers.find((server) => server.config.id === serverId)?.config.name;
}

function getChatScopeSubtitle(
  chat: Chat | null,
  workspaces: Workspace[],
  servers: SshServer[],
): string | undefined {
  if (!chat) {
    return undefined;
  }
  const source = chat.config.source;
  if (source?.kind === "ssh_server") {
    return getServerName(source.sshServerId, servers);
  }
  if (source?.kind === "execution_host") {
    return source.executionHost.targetKey;
  }
  return getWorkspaceScopeSubtitle(source?.workspaceId ?? chat.config.workspaceId, workspaces);
}

function getStandaloneSshSessionScopeSubtitle({
  sshServerSessionId,
  sessionsByServerId,
  servers,
}: {
  sshServerSessionId: string | undefined;
  sessionsByServerId: Record<string, SshServerSession[]>;
  servers: SshServer[];
}): string | undefined {
  if (!sshServerSessionId) {
    return undefined;
  }

  for (const [serverId, serverSessions] of Object.entries(sessionsByServerId)) {
    if (serverSessions.some((session) => session.config.id === sshServerSessionId)) {
      return getServerName(serverId, servers);
    }
  }

  return undefined;
}

function getTerminalSessionScopeSubtitle(
  terminalSessionId: string | undefined,
  terminalSessions: import("@/shared").WorkspaceTerminalSession[],
  workspaces: Workspace[],
): string | undefined {
  if (!terminalSessionId) {
    return undefined;
  }
  const terminalSession = terminalSessions.find((session) => session.config.id === terminalSessionId);
  return terminalSession
    ? getWorkspaceScopeSubtitle(terminalSession.config.workspaceId, workspaces)
    : undefined;
}

interface HeaderScopeOptions {
  route: WebAppRoute;
  composeKind: string | undefined;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  composeExecutionHost: ExecutionHostDescriptor | null;
  selectedTask: Task | null;
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  selectedServer: SshServer | null;
  selectedAgent: Agent | null;
  agentRunWorkspaceId: string | undefined;
  terminalSessions: import("@/shared").WorkspaceTerminalSession[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  servers: SshServer[];
  workspaces: Workspace[];
}

function getHeaderScopeSubtitle({
  route,
  composeKind,
  composeWorkspace,
  composeServer,
  composeExecutionHost,
  selectedTask,
  selectedChat,
  selectedWorkspace,
  selectedServer,
  selectedAgent,
  agentRunWorkspaceId,
  terminalSessions,
  sessionsByServerId,
  servers,
  workspaces,
}: HeaderScopeOptions): string | undefined {
  switch (route.view) {
    case "task":
    case "task-files":
      return getWorkspaceScopeSubtitle(selectedTask?.config.workspaceId, workspaces);
    case "chat":
    case "chat-transcript":
      return getChatScopeSubtitle(selectedChat, workspaces, servers);
    case "ssh":
      return getStandaloneSshSessionScopeSubtitle({
        sshServerSessionId: getRouteString(route, "sshServerSessionId"),
        sessionsByServerId,
        servers,
      });
    case "terminal":
      return getTerminalSessionScopeSubtitle(
        getRouteString(route, "terminalSessionId"),
        terminalSessions,
        workspaces,
      );
    case "agent":
      return getWorkspaceScopeSubtitle(selectedAgent?.config.workspaceId, workspaces);
    case "agent-run":
      return getWorkspaceScopeSubtitle(selectedAgent?.config.workspaceId ?? agentRunWorkspaceId, workspaces);
    case "agents":
      return getWorkspaceScopeSubtitle(getRouteString(route, "workspaceId"), workspaces);
    case "code-explorer": {
      const contentType = getRouteString(route, "contentType");
      if (contentType === "task") {
        return getWorkspaceScopeSubtitle(selectedTask?.config.workspaceId, workspaces);
      }
      if (contentType === "chat") {
        return getChatScopeSubtitle(selectedChat, workspaces, servers);
      }
      if (contentType === "workspace") {
        return selectedWorkspace
          ? getWorkspaceScopeSubtitle(selectedWorkspace.id, workspaces)
          : undefined;
      }
      if (contentType === "server") {
        return selectedServer?.config.name;
      }
      return undefined;
    }
    case "compose":
      if (composeKind === "workspace") {
        return undefined;
      }
      return composeWorkspace
        ? getWorkspaceScopeSubtitle(composeWorkspace.id, workspaces)
        : composeServer?.config.name ?? composeExecutionHost?.name;
    default:
      return undefined;
  }
}

export function useShellHeader({
  route,
  headerNodes,
  registeredHeaderActions,
  navigateWithinShell,
  taskId,
  chatId,
  composeKind,
  selectedTask,
  selectedChat,
  selectedWorkspace,
  composeWorkspace,
  composeServer,
  composeExecutionHost,
  selectedServer,
  selectedAgent,
  tasksLoading,
  chatsLoading,
  agents,
  servers,
  terminalSessions,
  sessionsByServerId,
  workspaces,
  editingAgentId,
  composeActionState,
}: UseShellHeaderOptions) {
  const headerOwnerRoute = useMemo(() => {
    return getHeaderOwnerRoute(route);
  }, [route]);
  const headerNode = useMemo(
    () => headerOwnerRoute
      ? headerNodes.find((node) => sidebarNodeMatchesRoute(node, headerOwnerRoute)) ?? null
      : null,
    [headerNodes, headerOwnerRoute],
  );
  const headerModel = useMemo<HeaderModel>(() => {
    const nodeModel: HeaderNodeModel | null = headerNode
      ? {
          title: headerNode.title,
          nodeSubtitle: headerNode.subtitle,
          badge: headerNode.badge,
          badgeVariant: headerNode.badgeVariant,
        }
      : null;
    const agentRun = route.view === "agent-run"
      ? (() => {
          const agentId = getRouteString(route, "agentId");
          const runId = getRouteString(route, "runId");
          return agentId && runId
            ? (agents.runsByAgentId[agentId] ?? []).find((item) => item.id === runId) ?? null
            : null;
        })()
      : null;
    const scopeSubtitle = getHeaderScopeSubtitle({
      route,
      composeKind,
      composeWorkspace,
      composeServer,
      composeExecutionHost,
      selectedTask,
      selectedChat,
      selectedWorkspace,
      selectedServer,
      selectedAgent,
      agentRunWorkspaceId: agentRun?.configSnapshot.workspaceId,
      terminalSessions,
      sessionsByServerId,
      servers,
      workspaces,
    });

    switch (route.view) {
      case "home":
        return { title: "Clanky" };
      case "task":
        if (taskId && !selectedTask && !tasksLoading) {
          return { title: "Task not found" };
        }
        if (!nodeModel) {
          return { title: "Task" };
        }
        return selectedTask?.state.status === "draft"
          ? { ...nodeModel, title: `Edit ${nodeModel.title}`, scopeSubtitle }
          : { ...nodeModel, scopeSubtitle };
      case "task-files":
        return nodeModel
          ? { title: nodeModel.title, scopeSubtitle, detailSubtitle: "Files" }
          : { title: "Task files" };
      case "chat":
        if (chatId && !selectedChat && !chatsLoading) {
          return { title: "Chat not found" };
        }
        return nodeModel ? { ...nodeModel, scopeSubtitle } : { title: "Chat" };
      case "chat-transcript":
        return nodeModel
          ? { title: nodeModel.title, scopeSubtitle, detailSubtitle: "Transcript" }
          : { title: "Chat transcript" };
      case "ssh":
        return nodeModel
          ? { ...nodeModel, scopeSubtitle }
          : { title: "SSH session", scopeSubtitle };
      case "terminal":
        return nodeModel ? { ...nodeModel, scopeSubtitle } : { title: "Terminal" };
      case "workspace":
        if (!nodeModel) {
          return {
            title: selectedWorkspace?.name ?? "Workspace",
          };
        }
        if (!selectedWorkspace) {
          return { ...nodeModel };
        }
        const workspaceAgent = selectedWorkspace.serverSettings.agent;
        if (workspaceAgent.transport === "stdio") {
          return {
            ...nodeModel,
            detailSubtitle: "stdio",
          };
        }
        const workspaceHostname = workspaceAgent.hostname.trim() || "127.0.0.1";
        const workspacePort = workspaceAgent.port ?? 22;
        const registeredServer = findRegisteredSshServer(workspaceHostname, servers);
        const workspaceServerLabel = registeredServer?.config.name ?? workspaceHostname;
        return {
          ...nodeModel,
          detailSubtitle: workspacePort === 22 ? workspaceServerLabel : `${workspaceServerLabel}:${workspacePort}`,
        };
      case "workspace-files":
        return nodeModel
          ? { title: nodeModel.title, detailSubtitle: "Files" }
          : { title: "Workspace files" };
      case "workspace-previews":
        return nodeModel
          ? { title: nodeModel.title, detailSubtitle: "Live previews" }
          : { title: "Live previews" };
      case "workspace-settings":
        return nodeModel
          ? { title: nodeModel.title, detailSubtitle: "Workspace settings" }
          : { title: "Workspace settings" };
      case "ssh-server":
        if (!selectedServer) {
          return nodeModel ?? { title: "SSH server" };
        }
        const standaloneSessions = sessionsByServerId[selectedServer.config.id] ?? [];
        return {
          title: selectedServer.config.name,
          detailSubtitle: `${selectedServer.config.username}@${selectedServer.config.address}`,
          badge: `${standaloneSessions.length} session${standaloneSessions.length === 1 ? "" : "s"}`,
          badgeVariant: "default",
          badgeIsStatus: false,
        };
      case "execution-host":
        return nodeModel ?? { title: "Execution server" };
      case "execution-host-files":
        return nodeModel
          ? { title: nodeModel.title, detailSubtitle: "Files" }
          : { title: "Server files" };
      case "vnc-session":
        return nodeModel
          ? {
              title: nodeModel.title,
              detailSubtitle: nodeModel.nodeSubtitle
                ? `VNC session · ${nodeModel.nodeSubtitle}`
                : "VNC session",
            }
          : { title: "VNC session" };
      case "ssh-server-settings":
        return nodeModel
          ? {
              title: nodeModel.title,
              detailSubtitle: nodeModel.nodeSubtitle
                ? `SSH server settings · ${nodeModel.nodeSubtitle}`
                : "SSH server settings",
            }
          : { title: "SSH server settings" };
      case "server-files":
        return nodeModel
          ? {
              title: nodeModel.title,
              detailSubtitle: nodeModel.nodeSubtitle
                ? `Files · ${nodeModel.nodeSubtitle}`
                : "Files",
            }
          : { title: "Server files" };
      case "server-arise":
        return nodeModel ? { title: `Arise ${nodeModel.title}` } : { title: "Arise" };
      case "provisioning-job":
        return { title: "Provisioning" };
      case "agent": {
        const agentId = getRouteString(route, "agentId");
        if (agentId && !selectedAgent && !agents.loading) {
          return { title: "Agent not found" };
        }
        const agent = selectedAgent;
        const agentWorkspace = agent
          ? workspaces.find((workspace) => workspace.id === agent.config.workspaceId)
          : undefined;
        return editingAgentId && editingAgentId === agentId
          ? { title: `Edit agent ${agent?.config.name ?? nodeModel?.title ?? ""}`.trim(), scopeSubtitle }
          : agent
            ? {
                title: agent.config.name,
                scopeSubtitle,
                detailSubtitle: agentWorkspace?.directory,
                badge: formatStatusLabel(agent.state.status),
                badgeVariant: getAgentStatusBadgeVariant(agent.state.status),
                detailSubtitleMobileHidden: true,
              }
            : nodeModel ?? { title: "Agent" };
      }
      case "agent-run": {
        const agent = selectedAgent;
        return {
          title: agent?.config.name ?? agentRun?.configSnapshot.name ?? "Agent run",
          scopeSubtitle,
          detailSubtitle: agentRun ? `Run · ${agentRun.status}` : "Agent run",
        };
      }
      case "agents": {
        const workspaceId = getRouteString(route, "workspaceId");
        const workspace = workspaceId ? workspaces.find((item) => item.id === workspaceId) : null;
        return {
          title: workspace ? `Agents in ${workspace.name}` : "Agents",
          scopeSubtitle,
          detailSubtitle: workspace?.directory,
        };
      }
      case "code-explorer": {
        const contentType = getRouteString(route, "contentType");
        const startDirectory = getRouteString(route, "startDirectory")?.trim();
        const explorerDirectory = startDirectory || (
          contentType === "workspace"
            ? selectedWorkspace?.directory
            : contentType === "task" && selectedTask
              ? getTaskCodeExplorerRootDirectory(selectedTask)
              : contentType === "chat" && selectedChat
                ? getChatCodeExplorerRootDirectory(selectedChat)
                : contentType === "server"
                  ? selectedServer?.config.repositoriesBasePath?.trim() || "/"
                  : undefined
        );
        return {
          title: headerNode ? `${headerNode.title} code explorer` : "Code Explorer",
          scopeSubtitle,
          detailSubtitle: explorerDirectory || nodeModel?.nodeSubtitle,
        };
      }
      case "compose": {
        if (composeKind === "task") {
          return {
            title: composeWorkspace ? `Start a new task in ${composeWorkspace.name}` : "Start a new task",
            scopeSubtitle,
          };
        }
        if (
          composeKind === "chat"
          || composeKind === "ssh-server-chat"
          || composeKind === "execution-host-chat"
        ) {
          return {
            title: composeExecutionHost
              ? `Start a new chat on ${composeExecutionHost.name}`
              : composeServer
                ? `Start a new chat on ${composeServer.config.name}`
                : composeWorkspace ? `Start a new chat in ${composeWorkspace.name}` : "Start a new chat",
            scopeSubtitle,
            detailSubtitle: composeServer
              ? `${composeServer.config.username}@${composeServer.config.address}`
              : undefined,
          };
        }
        if (composeKind === "agent") {
          return {
            title: composeWorkspace ? `Start a new agent in ${composeWorkspace.name}` : "Start a new agent",
            scopeSubtitle,
          };
        }
        if (composeKind === "workspace") {
          return { title: "Create a workspace" };
        }
        if (composeKind === "ssh-session") {
          return {
            title: composeServer ? "Create an SSH session" : "Create a standalone SSH session",
            scopeSubtitle,
          };
        }
        if (composeKind === "ssh-server") {
          return {
            title: composeServer ? `Edit ${composeServer.config.name}` : "Register a standalone SSH server",
            scopeSubtitle,
            detailSubtitle: composeServer ? "Update the saved host metadata and optional client-only password." : undefined,
          };
        }
        return { title: "Compose" };
      }
      case "rebuild-workspace":
        return selectedWorkspace ? { title: `Rebuild ${selectedWorkspace.name}` } : { title: "Rebuild workspace" };
      case "restart-workspace":
        return selectedWorkspace ? { title: `Restart ${selectedWorkspace.name}` } : { title: "Restart workspace" };
      default:
        return {};
    }
  }, [
    agents.loading,
    agents.runsByAgentId,
    chatId,
    chatsLoading,
    composeKind,
    composeServer,
    composeExecutionHost,
    composeWorkspace,
    editingAgentId,
    headerNode,
    route,
    selectedAgent,
    selectedChat,
    selectedServer,
    selectedTask,
    selectedWorkspace,
    terminalSessions,
    servers,
    sessionsByServerId,
    taskId,
    tasksLoading,
    workspaces,
  ]);
  const headerActions = useMemo<ActionMenuItem[]>(() => {
    const ownerActions = headerNode?.actions ?? [];
    if (route.view === "code-explorer" || route.view === "agent-run") {
      return [];
    }
    if (headerOwnerRoute && headerNode && !sidebarNodeMatchesRoute(headerNode, route)) {
      return ownerActions;
    }
    return [];
  }, [headerNode, headerOwnerRoute, route]);
  const directHeaderActions = useMemo<ReactNode>(() => {
    if (route.view === "agent-run") {
      const agentId = getRouteString(route, "agentId");
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigateWithinShell(agentId ? { view: "agent", agentId } : HOME_ROUTE)}
        >
          Back
        </Button>
      );
    }

    if (route.view === "provisioning-job") {
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigateWithinShell(getProvisioningReturnRoute(route))}
        >
          Back
        </Button>
      );
    }

    if (route.view === "code-explorer") {
      if (!headerOwnerRoute) {
        return null;
      }
      const contentType = getRouteString(route, "contentType");
      const backLabel = contentType === "task"
        ? "Back to task"
        : contentType === "chat"
          ? "Back to chat"
          : contentType === "server" || contentType === "execution-host"
            ? "Back to server"
            : "Back to workspace";
      return (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigateWithinShell(headerOwnerRoute ?? HOME_ROUTE)}
        >
          {backLabel}
        </Button>
      );
    }

    if (route.view === "compose" && composeKind === "task") {
      return (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={composeActionState?.onCancel ?? (() => navigateWithinShell(
              composeWorkspace ? { view: "workspace", workspaceId: composeWorkspace.id } : HOME_ROUTE,
            ))}
            disabled={composeActionState?.isSubmitting}
          >
            Cancel
          </Button>
          {composeActionState
            && (!composeActionState.isEditing || composeActionState.isEditingDraft) && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={composeActionState.onSaveAsDraft}
                disabled={!composeActionState.canSaveDraft}
                loading={composeActionState.isSubmitting}
              >
                {composeActionState.isEditingDraft ? "Update" : "Save as Draft"}
              </Button>
            )}
          {composeActionState ? (
            <Button
              type="button"
              size="sm"
              onClick={composeActionState.onSubmit}
              disabled={!composeActionState.canSubmit}
              loading={composeActionState.isSubmitting}
            >
              {composeActionState.isEditing ? "Start" : "Create"}
            </Button>
          ) : null}
        </>
      );
    }

    return registeredHeaderActions?.actions ?? null;
  }, [
    composeActionState,
    composeKind,
    composeWorkspace,
    headerOwnerRoute,
    navigateWithinShell,
    registeredHeaderActions,
    route,
  ]);

  return {
    headerOwnerRoute,
    headerNode,
    headerModel,
    headerActions,
    directHeaderActions,
  };
}
