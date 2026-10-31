import type { SidebarNode } from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
  TerminalSession,
  Workspace,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import { formatStatusLabel, getChatStatusBadgeVariant } from "../common";
import { getServerTransportLabel } from "./server-sidebar-item";
import {
  createChatSidebarNode,
  type ChatSidebarContext,
} from "./shell-sidebar-chat";
import {
  createTerminalSessionSidebarNode,
  type TerminalSessionSidebarContext,
} from "./shell-sidebar-terminal-session";
import {
  getPrivateHidden,
  privateSidebarPresentation,
  renderServerSidebarItem,
} from "./shell-sidebar-utils";
import {
  executionHostId,
  executionHostUsable,
  getExecutionHostChatRoute,
  getExecutionHostSidebarActions,
  getExecutionHostTerminalRoute,
  getExecutionHostWorkspaceRoute,
  type ExecutionHostSidebarContext,
} from "./shell-sidebar-execution-host";

export interface ServerSidebarContext {
  execution: ExecutionHostSidebarContext;
  chat: ChatSidebarContext;
  terminal: TerminalSessionSidebarContext;
  showPrivateItems: boolean;
}

export interface BuildServerSidebarNodesOptions {
  executionHosts: ExecutionHostDescriptor[];
  remoteOnly: boolean;
  chats: Chat[];
  terminalSessions: TerminalSession[];
  workspaces: Workspace[];
  context: ServerSidebarContext;
}

export function buildServerSidebarNodes({
  executionHosts,
  remoteOnly,
  chats,
  terminalSessions,
  workspaces,
  context,
}: BuildServerSidebarNodesOptions): SidebarNode[] {
  return executionHosts
    .filter((host) => !remoteOnly || host.ref.kind !== "local")
    .map((host): SidebarNode => {
      const hostId = executionHostId(host);
      const belongsToHost = (ref: import("@/shared").ExecutionHostRef | undefined) => {
        if (!ref || ref.kind !== host.ref.kind) {
          return false;
        }
        return getExecutionHostSourceId(ref) === hostId;
      };
      const hostChats = chats.filter((chat) => {
        const source = chat.config.source;
        return source?.kind === "execution_host"
          && belongsToHost(source.executionHost.host);
      });
      const hostTerminals = terminalSessions.filter((session) => (
        !session.config.workspaceId && belongsToHost(session.config.executionHostBinding.host)
      ));
      const hostWorkspaces = workspaces.filter((workspace) => (
        belongsToHost(workspace.executionHostBinding.host)
      ));
      const hostPrivateHidden = getPrivateHidden(
        host,
        [],
        context.showPrivateItems,
      );
      const subtitle = host.ref.kind === "mesh" && host.meshRouteKind === "relay"
        ? "Connected via relay"
        : host.endpoint ?? (
            host.ref.kind === "local" ? "This server" : "Endpoint unavailable"
          );
      const actions = getExecutionHostSidebarActions(host, context.execution);
      return privateSidebarPresentation({
        type: "item",
        id: `execution-host:${host.ref.kind}:${hostId}`,
        title: host.name,
        subtitle,
        badge: getServerTransportLabel(host.ref.kind),
        badgeVariant: "default",
        render: renderServerSidebarItem(host.ref.kind),
        route: {
          view: "execution-host",
          hostKind: host.ref.kind,
          hostId,
        },
        actions,
        pinnable: true,
        pinId: `execution-host:${host.ref.kind}:${hostId}`,
        children: [
          {
            type: "section",
            id: `execution-host:${host.ref.kind}:${hostId}:workspaces`,
            title: "Workspaces",
            action: {
              id: "new-workspace",
              title: "New workspace",
              label: "New",
              route: executionHostUsable(host) && host.capabilities.provisioning
                ? getExecutionHostWorkspaceRoute(host)
                : undefined,
            },
            children: hostWorkspaces.map((workspace): SidebarNode => ({
              type: "item",
              id: `workspace:${workspace.id}`,
              title: workspace.name,
              route: { view: "workspace", workspaceId: workspace.id },
              pinnable: true,
              pinId: `workspace:${workspace.id}`,
            })),
          },
          {
            type: "section",
            id: `execution-host:${host.ref.kind}:${hostId}:terminals`,
            title: "Terminals",
            action: {
              id: "new-terminal",
              title: "New terminal",
              label: "New",
              route: executionHostUsable(host) && host.capabilities.interactiveTerminal
                ? getExecutionHostTerminalRoute(host)
                : undefined,
            },
            children: hostTerminals.map((session): SidebarNode =>
              createTerminalSessionSidebarNode({
                session,
                target: {
                  id: session.config.id,
                  name: session.config.name,
                },
                id: `terminal-session:${session.config.id}`,
                title: session.config.name,
                ancestors: [host],
                pinId: `terminal-session:${session.config.id}`,
              }, context.terminal)
            ),
          },
          {
            type: "section",
            id: `execution-host:${host.ref.kind}:${hostId}:chats`,
            title: "Chats",
            action: {
              id: "new-chat",
              title: "New chat",
              label: "New",
              route: executionHostUsable(host) && host.capabilities.acpRuntime
                ? getExecutionHostChatRoute(host)
                : undefined,
            },
            children: hostChats.map((chat): SidebarNode =>
              createChatSidebarNode({
                chatNode: {
                  chat,
                  title: chat.config.name,
                  badge: formatStatusLabel(chat.state.status),
                  badgeVariant: getChatStatusBadgeVariant(chat.state.status),
                },
                ancestors: [host],
                idPrefix: "chat",
              }, context.chat)
            ),
          },
        ],
      }, hostPrivateHidden, actions);
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}
