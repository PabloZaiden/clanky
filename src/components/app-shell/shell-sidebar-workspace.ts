import type {
  ActionMenuItem,
} from "@pablozaiden/webapp/web";
import { isRestartableAutomaticWorkspace } from "@/shared";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  renderActiveWorkSidebarItem,
  renderWorkspaceSidebarItem,
  sidebarActionItems,
  sortSidebarNodesByActivity,
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
  createTerminalSessionSidebarNode,
  type TerminalSessionSidebarContext,
} from "./shell-sidebar-terminal-session";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";

export interface WorkspaceSidebarContext {
  navigateWithinShell: ChatSidebarContext["navigateWithinShell"];
  showPrivateItems: boolean;
}

export interface WorkspaceSidebarBuilderContext {
  workspace: WorkspaceSidebarContext;
  chat: ChatSidebarContext;
  terminal: TerminalSessionSidebarContext;
}

function getWorkspaceSidebarActions(
  workspaceNode: SidebarWorkspaceGroupNode["workspaces"][number],
  context: WorkspaceSidebarContext,
): ActionMenuItem[] {
  const capabilities = getClankyClientCapabilities();
  const workspaceId = workspaceNode.workspace.id;
  const actions = sidebarActionItems([
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
        id: "new-terminal-session",
        label: "New Terminal",
        disabled: !capabilities.terminalManagement,
        onClick: () => context.navigateWithinShell({
          view: "compose",
          kind: "terminal-session",
          workspaceId,
        }),
      },
      {
        id: "new-automation",
        label: "New Automation",
        onClick: () => context.navigateWithinShell({
          view: "compose",
          kind: "automation",
          workspaceId,
        }),
      },
      {
        id: "open-code-explorer",
        label: "Code Explorer",
        onClick: () => context.navigateWithinShell({
          view: "code-explorer",
          contentType: "workspace",
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
        id: "workspace-settings",
        label: "Workspace Settings",
        onClick: () => context.navigateWithinShell({
          view: "workspace-settings",
          workspaceId,
        }),
      },
    ]);
  if (decodeCollaborationResourceReference(workspaceId) && workspaceNode.workspace.access !== "admin") {
    const administrative = new Set(["workspace-settings", "restart-workspace", "rebuild-workspace"]);
    return actions.filter((action) => action.id === undefined || !administrative.has(action.id));
  }
  if (decodeCollaborationResourceReference(workspaceId)) {
    return actions.filter((action) =>
      action.id !== "restart-workspace" && action.id !== "rebuild-workspace");
  }
  return actions;
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
