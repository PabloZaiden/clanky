import type {
  ActionMenuItem,
  SidebarNode,
} from "@pablozaiden/webapp/web";
import type {
  Agent,
  Workspace,
} from "@/shared";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { apiRequest } from "../../lib/api-client";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  sidebarActionItems,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";
import type { SearchableSidebarNode } from "./shell-sidebar-types";
import type {
  SidebarWorkspaceGroupNode,
} from "./shell-types";
import {
  createAgentSidebarNode,
  type AgentSidebarContext,
} from "./shell-sidebar-agent";
import {
  createChatSidebarNode,
  type ChatSidebarContext,
} from "./shell-sidebar-chat";
import {
  createTaskSidebarNode,
  type TaskSidebarContext,
} from "./shell-sidebar-task";
import {
  createTerminalSessionSidebarNode,
  type TerminalSessionSidebarContext,
} from "./shell-sidebar-terminal-session";

export interface WorkspaceSidebarContext {
  navigateWithinShell: ChatSidebarContext["navigateWithinShell"];
  onError: (message: string) => void;
  toggleWorkspacePrivate: (workspace: Workspace) => void | Promise<void>;
  startAgentImport: (workspaceId: string) => void;
  pullLatestWorkspaceChanges: (workspaceId: string) => void | Promise<void>;
  pullingLatestWorkspaceIds: ReadonlySet<string>;
  toggleWorkspaceArchived: (workspace: Workspace) => void | Promise<void>;
  archivingWorkspaceIds: ReadonlySet<string>;
  showPrivateItems: boolean;
}

export interface WorkspaceSidebarBuilderContext {
  workspace: WorkspaceSidebarContext;
  chat: ChatSidebarContext;
  task: TaskSidebarContext;
  terminal: TerminalSessionSidebarContext;
  agentNodesByWorkspace: ReadonlyMap<string, SidebarNode[]>;
}

export async function openWorkspaceGitHubUrl(
  workspace: Workspace,
  onError: (message: string) => void,
): Promise<void> {
  const persistedUrl = normalizeGitHubRepositoryUrl(workspace.repoUrl ?? "");
  if (persistedUrl) {
    window.open(persistedUrl, "_blank", "noopener,noreferrer");
    return;
  }

  let fetchedUrl: string | null;
  try {
    const data = await apiRequest<{ githubUrl?: unknown }>(
      `/api/git/github-repository-url?workspaceId=${encodeURIComponent(workspace.id)}`,
      {
        action: "Load GitHub repository URL",
        fallbackMessage: "GitHub repository URL is not available for this workspace",
      },
    );
    fetchedUrl = typeof data.githubUrl === "string"
      ? normalizeGitHubRepositoryUrl(data.githubUrl)
      : null;
  } catch (error) {
    onError(String(error));
    return;
  }

  if (!fetchedUrl) {
    onError("GitHub repository URL is not available for this workspace");
    return;
  }

  window.open(fetchedUrl, "_blank", "noopener,noreferrer");
}

export function buildAgentSidebarNodesByWorkspace(
  agents: Agent[],
  workspaces: Workspace[],
  context: AgentSidebarContext,
): ReadonlyMap<string, SidebarNode[]> {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const agentNodesByWorkspace = new Map<string, SidebarNode[]>();
  for (const agent of agents) {
    const workspaceAgents = agentNodesByWorkspace.get(agent.config.workspaceId) ?? [];
    const workspace = workspaceById.get(agent.config.workspaceId) ?? null;
    workspaceAgents.push(createAgentSidebarNode(agent, [workspace], context));
    agentNodesByWorkspace.set(agent.config.workspaceId, workspaceAgents);
  }
  return agentNodesByWorkspace;
}

function getWorkspaceSidebarActions(
  workspaceNode: SidebarWorkspaceGroupNode["workspaces"][number],
  context: WorkspaceSidebarContext,
): ActionMenuItem[] {
  const workspaceId = workspaceNode.workspace.id;
  const workspaceArchived = workspaceNode.workspace.archived === true;
  const workspaceArchiving = context.archivingWorkspaceIds.has(workspaceId);
  const isGitBacked = workspaceNode.workspace.workspaceType === "git";
  return withPrivateToggleAction(
    sidebarActionItems([
      ...(isGitBacked ? [{
          id: "new-task",
          label: "New Task",
          onClick: () => context.navigateWithinShell({
            view: "compose",
            kind: "task",
            scopeId: workspaceId,
          }),
        }] : []),
      {
        id: "new-chat",
        label: "New Chat",
        onClick: () => context.navigateWithinShell({
          view: "compose",
          kind: "chat",
          scopeId: workspaceId,
        }),
      },
      {
        id: "new-agent",
        label: "New Agent",
        onClick: () => context.navigateWithinShell({
          view: "compose",
          kind: "agent",
          workspaceId,
        }),
      },
      {
        id: "import-agent",
        label: "Import Agent",
        onClick: () => context.startAgentImport(workspaceId),
      },
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => context.navigateWithinShell({
          view: "code-explorer",
          contentType: "workspace",
          workspaceId,
        }),
      },
      {
        id: "workspace-previews",
        label: "Previews",
        onClick: () => context.navigateWithinShell({
          view: "workspace-previews",
          workspaceId,
        }),
      },
      ...(isGitBacked ? [
        {
          id: "pull-latest-changes",
          label: context.pullingLatestWorkspaceIds.has(workspaceId)
            ? "Pulling Latest Changes..."
            : "Pull Latest Changes",
          disabled: context.pullingLatestWorkspaceIds.has(workspaceId),
          onClick: () => void context.pullLatestWorkspaceChanges(workspaceId),
        },
        {
          id: "open-github",
          label: "Open in GitHub",
          onClick: () => void openWorkspaceGitHubUrl(
            workspaceNode.workspace,
            context.onError,
          ),
        },
      ] : []),
      {
        id: "new-terminal-session",
        label: "New Terminal",
        onClick: () => context.navigateWithinShell({
          view: "compose",
          kind: "terminal-session",
          workspaceId,
        }),
      },
      ...(workspaceNode.workspace.sourceDirectory ? [
        {
          id: "restart-workspace",
          label: "Restart",
          onClick: () => context.navigateWithinShell({
            view: "restart-workspace",
            workspaceId,
          }),
        },
        {
          id: "rebuild-workspace",
          label: "Rebuild",
          onClick: () => context.navigateWithinShell({
            view: "rebuild-workspace",
            workspaceId,
          }),
        },
      ] : []),
      {
        id: workspaceArchived ? "unarchive-workspace" : "archive-workspace",
        label: workspaceArchiving
          ? (workspaceArchived ? "Unarchiving Workspace..." : "Archiving Workspace...")
          : (workspaceArchived ? "Unarchive Workspace" : "Archive Workspace"),
        disabled: workspaceArchiving,
        onClick: () => void context.toggleWorkspaceArchived(workspaceNode.workspace),
      },
      {
        id: "workspace-settings",
        label: "Workspace Settings",
        onClick: () => context.navigateWithinShell({
          view: "workspace-settings",
          workspaceId,
        }),
      },
    ]),
    workspaceNode.workspace,
    () => void context.toggleWorkspacePrivate(workspaceNode.workspace),
  );
}

export function createWorkspaceSidebarNode(
  workspaceNode: SidebarWorkspaceGroupNode["workspaces"][number],
  context: WorkspaceSidebarBuilderContext,
): SearchableSidebarNode {
  const workspaceId = workspaceNode.workspace.id;
  const workspacePrivateHidden = getPrivateHidden(
    workspaceNode.workspace,
    [],
    context.workspace.showPrivateItems,
  );
  const isGitBacked = workspaceNode.workspace.workspaceType === "git";
  const children: SidebarNode[] = [
    ...(isGitBacked ? [{
      type: "section" as const,
      id: `workspace:${workspaceId}:tasks`,
      title: "Tasks",
      action: {
        id: "new-task",
        title: "New task",
        label: "New",
        route: workspacePrivateHidden
          ? undefined
          : { view: "compose", kind: "task", scopeId: workspaceId },
      },
      children: [
        ...workspaceNode.tasks.map((taskNode): SidebarNode =>
          createTaskSidebarNode({
            task: taskNode.task,
            id: `task:${taskNode.task.config.id}`,
            pinId: `task:${taskNode.task.config.id}`,
            title: taskNode.title,
            badge: taskNode.badge,
            badgeVariant: taskNode.badgeVariant,
            ancestors: [workspaceNode.workspace],
          }, context.task)
        ),
        ...(workspaceNode.historyTasks.length > 0 ? [{
          type: "section" as const,
          id: `workspace:${workspaceId}:history`,
          title: "History",
          defaultCollapsed: true,
          children: workspaceNode.historyTasks.map((taskNode): SidebarNode =>
            createTaskSidebarNode({
              task: taskNode.task,
              id: `task:${taskNode.task.config.id}`,
              pinId: `task:${taskNode.task.config.id}`,
              title: taskNode.title,
              badge: taskNode.badge,
              badgeVariant: taskNode.badgeVariant,
              ancestors: [workspaceNode.workspace],
            }, context.task)
          ),
        }] : []),
      ],
    }] : []),
    {
      type: "section",
      id: `workspace:${workspaceId}:chats`,
      title: "Chats",
      action: {
        id: "new-chat",
        title: "New chat",
        label: "New",
        route: workspacePrivateHidden
          ? undefined
          : { view: "compose", kind: "chat", scopeId: workspaceId },
      },
      children: [
        ...workspaceNode.chats.map((chatNode) =>
          createChatSidebarNode({
            chatNode,
            ancestors: [workspaceNode.workspace],
            idPrefix: "chat",
          }, context.chat)
        ),
        ...(workspaceNode.historyChats.length > 0 ? [{
          type: "section" as const,
          id: `workspace:${workspaceId}:chat-history`,
          title: "History",
          defaultCollapsed: true,
          children: workspaceNode.historyChats.map((chatNode) =>
            createChatSidebarNode({
              chatNode,
              ancestors: [workspaceNode.workspace],
              idPrefix: "chat",
            }, context.chat)
          ),
        }] : []),
      ],
    },
    {
      type: "section",
      id: `workspace:${workspaceId}:agents`,
      title: "Agents",
      action: {
        id: "new-agent",
        title: "New agent",
        label: "New",
        route: workspacePrivateHidden
          ? undefined
          : { view: "compose", kind: "agent", workspaceId },
      },
      children: context.agentNodesByWorkspace.get(workspaceId) ?? [],
    },
    {
      type: "section",
      id: `workspace:${workspaceId}:terminal-sessions`,
      title: "Terminals",
      action: {
        id: "new-terminal-session",
        title: "New terminal",
        label: "New",
        route: workspacePrivateHidden
          ? undefined
          : { view: "compose", kind: "terminal-session", workspaceId },
      },
      children: workspaceNode.terminalSessions.map((terminalNode): SidebarNode =>
        createTerminalSessionSidebarNode({
          session: terminalNode.session,
          target: {
            id: terminalNode.session.config.id,
            name: terminalNode.session.config.name,
          },
          id: `terminal-session:${terminalNode.session.config.id}`,
          title: terminalNode.title,
          subtitle: terminalNode.subtitle,
          badge: terminalNode.badge,
          badgeVariant: terminalNode.badgeVariant,
          ancestors: [workspaceNode.workspace],
          pinId: `terminal-session:${terminalNode.session.config.id}`,
        }, context.terminal)
      ),
    },
  ];

  return privateSidebarPresentation({
    type: "item",
    id: `workspace:${workspaceId}`,
    title: workspaceNode.workspace.name,
    searchText: `${workspaceNode.workspace.directory} ${isGitBacked ? "git" : "directory"}`,
    route: { view: "workspace", workspaceId },
    actions: privateActions(
      getWorkspaceSidebarActions(workspaceNode, context.workspace),
      workspacePrivateHidden,
      workspaceNode.workspace.isPrivate === true,
    ),
    pinnable: true,
    pinId: `workspace:${workspaceId}`,
    children,
  }, workspacePrivateHidden);
}
