import type { SidebarNode } from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
  TerminalSession,
  Workspace,
} from "@/shared";
import {
  buildActiveWorkSidebarItems,
  type SidebarExecutionHostNode,
  type SidebarWorkspaceGroupNode,
} from "./shell-types";
import {
  renderActiveWorkSidebarItem,
} from "./shell-sidebar-utils";
import {
  buildAgentSidebarNodesByWorkspace,
  createWorkspaceSidebarNode,
  type WorkspaceSidebarBuilderContext,
} from "./shell-sidebar-workspace";
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
import {
  buildServerSidebarNodes,
  type ServerSidebarContext,
} from "./shell-sidebar-server";
import type { AgentSidebarContext } from "./shell-sidebar-agent";
import type { WorkspaceSidebarContext } from "./shell-sidebar-workspace";

export interface SidebarDomainBuilderContexts {
  chat: ChatSidebarContext;
  task: TaskSidebarContext;
  terminal: TerminalSessionSidebarContext;
  agent: AgentSidebarContext;
  workspace: WorkspaceSidebarContext;
  server: ServerSidebarContext;
}

export interface BuildSidebarDomainNodesOptions {
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  executionHostNodes: SidebarExecutionHostNode[];
  executionHosts: ExecutionHostDescriptor[];
  remoteOnly: boolean;
  chats: Chat[];
  terminalSessions: TerminalSession[];
  workspaces: Workspace[];
  agents: import("@/shared").Agent[];
  contexts: SidebarDomainBuilderContexts;
}

export function buildSidebarDomainNodes({
  sidebarWorkspaceGroups,
  executionHostNodes,
  executionHosts,
  remoteOnly,
  chats,
  terminalSessions,
  workspaces,
  agents,
  contexts,
}: BuildSidebarDomainNodesOptions): SidebarNode[] {
  const activeWork = buildActiveWorkSidebarItems(sidebarWorkspaceGroups, { executionHostNodes }).map((item): SidebarNode => {
    if (item.kind === "task") {
      return createTaskSidebarNode({
        id: item.key,
        pinId: item.key,
        task: item.taskNode.task,
        title: item.taskNode.title,
        subtitle: item.workspaceName,
        badge: item.taskNode.badge,
        badgeVariant: item.taskNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem("Task"),
        ancestors: [item.workspace],
      }, contexts.task);
    }
    if (item.kind === "chat" || item.kind === "execution-host-chat") {
      const ancestors = item.kind === "chat" ? [item.workspace] : [item.host];
      return createChatSidebarNode({
        chatNode: item.chatNode,
        idPrefix: "chat",
        id: item.key,
        pinId: item.key,
        ancestors,
        subtitle: item.kind === "chat" ? item.workspaceName : item.host.name,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem("Chat"),
      }, contexts.chat);
    }
    if (item.kind === "terminal-session") {
      const terminalId = item.sessionNode.session.config.id;
      const terminalSession = item.sessionNode.session;
      return createTerminalSessionSidebarNode({
        session: terminalSession,
        target: {
          id: terminalId,
          name: terminalSession.config.name,
        },
        id: item.key,
        pinId: item.key,
        title: item.sessionNode.title,
        subtitle: item.workspaceName,
        ancestors: [item.workspace],
        badge: item.sessionNode.badge,
        badgeVariant: item.sessionNode.badgeVariant,
        badgeAppearance: "text",
        itemLayout: "subtitle-above-title",
        render: renderActiveWorkSidebarItem("Terminal"),
      }, contexts.terminal);
    }
    const sessionId = item.sessionNode.session.config.id;
    return createTerminalSessionSidebarNode({
      session: item.sessionNode.session,
      target: {
        id: sessionId,
        name: item.sessionNode.title,
      },
      id: item.key,
      pinId: item.key,
      title: item.sessionNode.title,
      subtitle: item.host.name,
      ancestors: [item.host],
      badge: item.sessionNode.badge,
      badgeVariant: item.sessionNode.badgeVariant,
      badgeAppearance: "text",
      itemLayout: "subtitle-above-title",
      render: renderActiveWorkSidebarItem("Terminal"),
    }, contexts.terminal);
  });

  const agentNodesByWorkspace = buildAgentSidebarNodesByWorkspace(
    agents,
    workspaces,
    contexts.agent,
  );
  const workspaceContext: WorkspaceSidebarBuilderContext = {
    workspace: contexts.workspace,
    chat: contexts.chat,
    task: contexts.task,
    terminal: contexts.terminal,
    agentNodesByWorkspace,
  };
  const workspaceNodes = sidebarWorkspaceGroups.flatMap((group) => group.workspaces
    .filter((workspaceNode) => workspaceNode.workspace.archived !== true)
    .map((workspaceNode) => createWorkspaceSidebarNode(workspaceNode, workspaceContext)));
  const archivedWorkspaceNodes = sidebarWorkspaceGroups.flatMap((group) => group.workspaces
    .filter((workspaceNode) => workspaceNode.workspace.archived === true)
    .map((workspaceNode) => createWorkspaceSidebarNode(workspaceNode, workspaceContext)));
  const unifiedServerNodes = buildServerSidebarNodes({
    executionHosts,
    executionHostNodes,
    remoteOnly,
    chats,
    terminalSessions,
    workspaces,
    context: contexts.server,
  });

  return [
    ...(activeWork.length > 0
      ? [{ type: "section" as const, id: "active-work", title: "Active work", children: activeWork }]
      : []),
    {
      type: "section" as const,
      id: "workspaces",
      title: "Workspaces",
      action: {
        id: "new-workspace",
        title: "New workspace",
        label: "New",
        route: { view: "compose", kind: "workspace" },
      },
      children: workspaceNodes,
    },
    ...(archivedWorkspaceNodes.length > 0 ? [{
      type: "section" as const,
      id: "archived-workspaces",
      title: "Archived",
      children: archivedWorkspaceNodes,
    }] : []),
    {
      type: "section" as const,
      id: "ssh-servers",
      title: "Servers",
      action: {
        id: "new-ssh-server",
        title: "New SSH server",
        label: "New",
        route: { view: "compose", kind: "ssh-server" },
      },
      children: unifiedServerNodes,
    },
  ];
}
