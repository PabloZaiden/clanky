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
import { getRouteString } from "./route-fields";
import {
  getHeaderOwnerRoute,
  sidebarNodeMatchesRoute,
} from "./shell-sidebar-composition";
import { HOME_ROUTE } from "./use-shell-navigation";
import type { Agent, Chat, SshServer, SshServerSession, Task, Workspace } from "@/shared";
import { findRegisteredSshServer } from "@/shared";
import { Badge, Button, formatStatusLabel, getAgentStatusBadgeVariant, StatusBadge } from "../common";

export interface HeaderModel {
  title?: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
  badgeIsStatus?: boolean;
  subtitleMobileHidden?: boolean;
}

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
  selectedServer: SshServer | null;
  selectedAgent: Agent | null;
  tasksLoading: boolean;
  chatsLoading: boolean;
  agents: UseAgentsResult;
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  workspaces: Workspace[];
  editingAgentId: ShellDialogComposition["editingAgentId"];
  composeActionState: UseComposeStateResult["composeActionState"];
}

export function RouteHeaderTitle({ model, defaultTitle }: { model: HeaderModel; defaultTitle: string }) {
  return (
    <span className="flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden">
      <span className="min-w-0 flex-shrink truncate text-lg font-bold text-gray-900 dark:text-gray-100">
        {model.title ?? defaultTitle}
      </span>
      {model.badge ? (
        model.badgeIsStatus === false ? (
          <Badge variant={model.badgeVariant} size="sm" className="shrink-0">
            {model.badge}
          </Badge>
        ) : (
          <StatusBadge variant={model.badgeVariant} size="sm" className="shrink-0">
            {model.badge}
          </StatusBadge>
        )
      ) : null}
      {model.subtitle ? (
        <span className={`min-w-0 flex-shrink truncate text-xs font-normal text-gray-500 dark:text-gray-400 ${model.subtitleMobileHidden ? "hidden sm:inline" : ""}`}>
          {model.subtitle}
        </span>
      ) : null}
    </span>
  );
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
  selectedServer,
  selectedAgent,
  tasksLoading,
  chatsLoading,
  agents,
  servers,
  sessionsByServerId,
  workspaces,
  editingAgentId,
  composeActionState,
}: UseShellHeaderOptions) {
  const headerOwnerRoute = useMemo(() => getHeaderOwnerRoute(route), [route]);
  const headerNode = useMemo(
    () => headerOwnerRoute
      ? headerNodes.find((node) => sidebarNodeMatchesRoute(node, headerOwnerRoute)) ?? null
      : null,
    [headerNodes, headerOwnerRoute],
  );
  const headerModel = useMemo<HeaderModel>(() => {
    const nodeModel: HeaderModel | null = headerNode
      ? {
          title: headerNode.title,
          subtitle: headerNode.subtitle,
          badge: headerNode.badge,
          badgeVariant: headerNode.badgeVariant,
        }
      : null;

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
          ? { ...nodeModel, title: `Edit ${nodeModel.title}`, subtitle: undefined }
          : { ...nodeModel, subtitle: undefined };
      case "task-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Task files" };
      case "chat":
        if (chatId && !selectedChat && !chatsLoading) {
          return { title: "Chat not found" };
        }
        return nodeModel ? { ...nodeModel, subtitle: undefined } : { title: "Chat" };
      case "chat-transcript":
        return nodeModel
          ? { title: nodeModel.title, subtitle: "Transcript" }
          : { title: "Chat transcript" };
      case "ssh":
        return nodeModel ?? { title: "SSH session" };
      case "workspace":
        if (!nodeModel) {
          return { title: "Workspace" };
        }
        if (!selectedWorkspace) {
          return nodeModel;
        }
        const workspaceAgent = selectedWorkspace.serverSettings.agent;
        if (workspaceAgent.transport === "stdio") {
          return { ...nodeModel, subtitle: "stdio" };
        }
        const workspaceHostname = workspaceAgent.hostname.trim() || "127.0.0.1";
        const workspacePort = workspaceAgent.port ?? 22;
        const registeredServer = findRegisteredSshServer(workspaceHostname, servers);
        const workspaceServerLabel = registeredServer?.config.name ?? workspaceHostname;
        return {
          ...nodeModel,
          subtitle: workspacePort === 22 ? workspaceServerLabel : `${workspaceServerLabel}:${workspacePort}`,
        };
      case "workspace-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Workspace files" };
      case "workspace-previews":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Live previews${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Live previews" };
      case "workspace-settings":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Workspace settings${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Workspace settings" };
      case "ssh-server":
        if (!selectedServer) {
          return nodeModel ?? { title: "SSH server" };
        }
        const standaloneSessions = sessionsByServerId[selectedServer.config.id] ?? [];
        return {
          title: selectedServer.config.name,
          subtitle: `${selectedServer.config.username}@${selectedServer.config.address}`,
          badge: `${standaloneSessions.length} session${standaloneSessions.length === 1 ? "" : "s"}`,
          badgeVariant: "default",
          badgeIsStatus: false,
        };
      case "vnc-session":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `VNC session${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "VNC session" };
      case "ssh-server-settings":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `SSH server settings${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "SSH server settings" };
      case "server-files":
        return nodeModel
          ? { title: nodeModel.title, subtitle: `Files${nodeModel.subtitle ? ` · ${nodeModel.subtitle}` : ""}` }
          : { title: "Server files" };
      case "server-arise":
        return nodeModel ? { title: `Arise ${nodeModel.title}` } : { title: "Arise" };
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
          ? { title: `Edit agent ${agent?.config.name ?? nodeModel?.title ?? ""}`.trim() }
          : agent
            ? {
                title: agent.config.name,
                subtitle: agentWorkspace?.directory,
                badge: formatStatusLabel(agent.state.status),
                badgeVariant: getAgentStatusBadgeVariant(agent.state.status),
                subtitleMobileHidden: true,
              }
            : nodeModel ?? { title: "Agent" };
      }
      case "agent-run": {
        const agentId = getRouteString(route, "agentId");
        const runId = getRouteString(route, "runId");
        const agent = selectedAgent;
        const run = agentId && runId
          ? (agents.runsByAgentId[agentId] ?? []).find((item) => item.id === runId)
          : null;
        return {
          title: agent?.config.name ?? run?.configSnapshot.name ?? "Agent run",
          subtitle: run ? `Run · ${run.status}` : "Agent run",
        };
      }
      case "agents": {
        const workspaceId = getRouteString(route, "workspaceId");
        const workspace = workspaceId ? workspaces.find((item) => item.id === workspaceId) : null;
        return {
          title: workspace ? `Agents in ${workspace.name}` : "Agents",
          subtitle: workspace?.directory,
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
          subtitle: explorerDirectory || headerNode?.subtitle,
        };
      }
      case "compose": {
        if (composeKind === "task") {
          return {
            title: composeWorkspace ? `Start a new task in ${composeWorkspace.name}` : "Start a new task",
            subtitle: composeWorkspace?.directory,
          };
        }
        if (composeKind === "chat" || composeKind === "ssh-server-chat") {
          return {
            title: composeServer
              ? `Start a new chat on ${composeServer.config.name}`
              : composeWorkspace ? `Start a new chat in ${composeWorkspace.name}` : "Start a new chat",
            subtitle: composeServer
              ? `${composeServer.config.username}@${composeServer.config.address}`
              : composeWorkspace?.directory,
          };
        }
        if (composeKind === "agent") {
          return {
            title: composeWorkspace ? `Start a new agent in ${composeWorkspace.name}` : "Start a new agent",
            subtitle: composeWorkspace?.directory,
          };
        }
        if (composeKind === "workspace") {
          return { title: "Create a workspace" };
        }
        if (composeKind === "ssh-session") {
          return { title: "Create an SSH session" };
        }
        if (composeKind === "ssh-server") {
          return {
            title: composeServer ? `Edit ${composeServer.config.name}` : "Register a standalone SSH server",
            subtitle: composeServer ? "Update the saved host metadata and optional client-only password." : undefined,
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
    composeWorkspace,
    editingAgentId,
    headerNode,
    route,
    selectedAgent,
    selectedChat,
    selectedServer,
    selectedTask,
    selectedWorkspace,
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

    if (route.view === "code-explorer") {
      if (!headerOwnerRoute) {
        return null;
      }
      const contentType = getRouteString(route, "contentType");
      const backLabel = contentType === "task"
        ? "Back to task"
        : contentType === "chat"
          ? "Back to chat"
          : contentType === "server"
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
