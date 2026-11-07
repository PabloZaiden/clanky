import type {
  ActionMenuItem,
} from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { isRestartableAutomaticWorkspace } from "@/shared";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { apiRequest } from "../../lib/api-client";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  renderActiveWorkSidebarItem,
  renderWorkspaceSidebarItem,
  sidebarActionItems,
  sortSidebarNodesByActivity,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";
import type { SearchableSidebarNode } from "./shell-sidebar-types";
import {
  getTerminalLastInteractionAt,
  getWorkItemLastInteractionAt,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
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
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";

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

function getWorkspaceSidebarActions(
  workspaceNode: SidebarWorkspaceGroupNode["workspaces"][number],
  context: WorkspaceSidebarContext,
): ActionMenuItem[] {
  const capabilities = getClankyClientCapabilities();
  const workspaceId = workspaceNode.workspace.id;
  const workspaceArchived = workspaceNode.workspace.archived === true;
  const workspaceArchiving = context.archivingWorkspaceIds.has(workspaceId);
  const isGitBacked = workspaceNode.workspace.workspaceType === "git";
  const actions = sidebarActionItems([
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
        id: "open-scratchpad",
        label: "Scratchpad",
        onClick: () => context.navigateWithinShell({
          view: "scratchpad",
          workspaceId,
        }),
      },
      ...(capabilities.webPreviews ? [{
        id: "workspace-previews",
        label: "Previews",
        onClick: () => context.navigateWithinShell({
          view: "workspace-previews",
          workspaceId,
        }),
      }] : []),
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
      ...(capabilities.provisioning && isRestartableAutomaticWorkspace(workspaceNode.workspace) ? [
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
    ]);
  if (decodeCollaborationResourceReference(workspaceId) && workspaceNode.workspace.access !== "admin") {
    const administrative = new Set(["archive-workspace", "unarchive-workspace", "workspace-settings", "restart-workspace", "rebuild-workspace"]);
    return actions.filter((action) => action.id === undefined || !administrative.has(action.id));
  }
  if (decodeCollaborationResourceReference(workspaceId)) {
    return withPrivateToggleAction(actions.filter((action) =>
      action.id !== "restart-workspace" && action.id !== "rebuild-workspace"),
    workspaceNode.workspace, () => void context.toggleWorkspacePrivate(workspaceNode.workspace));
  }
  return withPrivateToggleAction(actions, workspaceNode.workspace, () => void context.toggleWorkspacePrivate(workspaceNode.workspace));
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
  const children = sortSidebarNodesByActivity([
    ...(isGitBacked ? [...workspaceNode.tasks, ...workspaceNode.historyTasks].map((taskNode) => ({
      lastActivityAt: getWorkItemLastInteractionAt(taskNode.task),
      node: createTaskSidebarNode({
        task: taskNode.task,
        id: `task:${taskNode.task.config.id}`,
        pinId: `task:${taskNode.task.config.id}`,
        title: taskNode.title,
        subtitle: workspaceNode.workspace.name,
        badge: taskNode.badge,
        badgeVariant: taskNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem(
          "Task",
          getWorkItemLastInteractionAt(taskNode.task),
          workspaceNode.workspace,
        ),
        ancestors: [workspaceNode.workspace],
      }, context.task),
    })) : []),
    ...[...workspaceNode.chats, ...workspaceNode.historyChats].map((chatNode) => ({
      lastActivityAt: getWorkItemLastInteractionAt(chatNode.chat),
      node: createChatSidebarNode({
        chatNode,
        subtitle: workspaceNode.workspace.name,
        ancestors: [workspaceNode.workspace],
        idPrefix: "chat",
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem(
          "Chat",
          getWorkItemLastInteractionAt(chatNode.chat),
          workspaceNode.workspace,
        ),
      }, context.chat),
    })),
    ...workspaceNode.terminalSessions.map((terminalNode) => ({
      lastActivityAt: getTerminalLastInteractionAt(terminalNode.session),
      node: createTerminalSessionSidebarNode({
        session: terminalNode.session,
        target: {
          id: terminalNode.session.config.id,
          name: terminalNode.session.config.name,
        },
        id: `terminal-session:${terminalNode.session.config.id}`,
        title: terminalNode.title,
        subtitle: workspaceNode.workspace.name,
        badge: terminalNode.badge,
        badgeVariant: terminalNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem(
          "Terminal",
          getTerminalLastInteractionAt(terminalNode.session),
          workspaceNode.workspace,
        ),
        ancestors: [workspaceNode.workspace],
        pinId: `terminal-session:${terminalNode.session.config.id}`,
      }, context.terminal),
    })),
  ]);

  const actions = getWorkspaceSidebarActions(workspaceNode, context.workspace);
  return privateSidebarPresentation({
    type: "item",
    id: `workspace:${workspaceId}`,
    title: workspaceNode.workspace.collaboration
      ? `${workspaceNode.workspace.name} (${workspaceNode.workspace.collaboration.controllerName})`
      : workspaceNode.workspace.name,
    render: renderWorkspaceSidebarItem(workspaceNode.workspace),
    searchText: `${workspaceNode.workspace.directory} ${isGitBacked ? "git" : "directory"}`,
    route: { view: "workspace", workspaceId },
    actions,
    pinnable: true,
    pinId: `workspace:${workspaceId}`,
    children,
  }, workspacePrivateHidden, privateActions(
    actions,
    workspacePrivateHidden,
    workspaceNode.workspace.isPrivate === true,
  ));
}
