import type {
  ActionMenuItem,
  SidebarItemRenderContext,
  SidebarNode,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import {
  isEffectivelyPrivate,
  privateSidebarPresentation,
  shouldObscurePrivateItem,
  type PrivateEntity,
} from "../../lib/private-items";
import { getRouteString } from "./route-fields";
import {
  ActiveWorkSidebarItem,
  type ActiveWorkSidebarItemType,
} from "./active-work-sidebar-item";
import {
  ServerSidebarItem,
  type ServerTransportKind,
} from "./server-sidebar-item";
import type { SearchableSidebarNode, SidebarAction } from "./shell-sidebar-types";

export function sidebarActionItems(
  items: Array<{
    id?: string;
    label: string;
    disabled?: boolean;
    destructive?: boolean;
    onClick: SidebarAction;
  }>,
): ActionMenuItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    destructive: item.destructive,
    onAction: () => void item.onClick(),
  }));
}

export function withPrivateToggleAction(
  items: ActionMenuItem[],
  entity: PrivateEntity,
  onToggle: () => void,
): ActionMenuItem[] {
  return [
    ...items,
    {
      id: entity.isPrivate ? "unmark-private" : "mark-private",
      label: entity.isPrivate ? "Unmark private" : "Mark as private",
      onAction: onToggle,
    },
  ];
}

export function privateActions(
  items: ActionMenuItem[],
  privateHidden: boolean,
  selfPrivate: boolean,
): ActionMenuItem[] {
  if (!privateHidden) {
    return items;
  }
  if (!selfPrivate) {
    return [];
  }
  return items.filter((item) => item.id === "unmark-private");
}

export function getPrivateHidden(
  entity: PrivateEntity | null | undefined,
  ancestors: Array<PrivateEntity | null | undefined>,
  showPrivateItems: boolean,
): boolean {
  return shouldObscurePrivateItem(
    isEffectivelyPrivate(entity, ancestors),
    showPrivateItems,
  );
}

export function filterSidebarNodes(nodes: SearchableSidebarNode[], search: string): SidebarNode[] {
  const normalized = search.trim().toLowerCase();
  if (!normalized) {
    return nodes;
  }

  const matches = (node: SearchableSidebarNode) => {
    if (node.privateHidden) {
      return false;
    }
    return `${node.title} ${node.subtitle ?? ""} ${node.searchText ?? ""}`.toLowerCase().includes(normalized);
  };
  return nodes.flatMap((node) => {
    const children = node.children
      ? filterSidebarNodes(node.children as SearchableSidebarNode[], search)
      : undefined;
    const childMatches = children !== undefined && children.length > 0;
    if (childMatches || (node.type !== "section" && matches(node))) {
      return [{ ...node, children, defaultCollapsed: false }];
    }
    return [];
  });
}

export function flattenSidebarNodes(nodes: SidebarNode[]): SidebarNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children ? flattenSidebarNodes(node.children) : []),
  ]);
}

export function sidebarNodeMatchesRoute(node: SidebarNode, route: WebAppRoute): boolean {
  if (!node.route || node.route.view !== route.view) {
    return false;
  }
  return Object.entries(node.route).every(([key, value]) => route[key] === value);
}

export function getHeaderOwnerRoute(route: WebAppRoute): WebAppRoute | null {
  switch (route.view) {
    case "task":
      return getRouteString(route, "taskId")
        ? { view: "task", taskId: getRouteString(route, "taskId")! }
        : null;
    case "task-files":
      return getRouteString(route, "taskId")
        ? { view: "task", taskId: getRouteString(route, "taskId")! }
        : null;
    case "chat":
    case "chat-transcript":
      return getRouteString(route, "chatId")
        ? { view: "chat", chatId: getRouteString(route, "chatId")! }
        : null;
    case "terminal":
      return getRouteString(route, "terminalSessionId")
        ? { view: "terminal", terminalSessionId: getRouteString(route, "terminalSessionId")! }
        : null;
    case "workspace":
    case "workspace-files":
    case "workspace-previews":
    case "workspace-settings":
    case "rebuild-workspace":
    case "restart-workspace":
      return getRouteString(route, "workspaceId")
        ? { view: "workspace", workspaceId: getRouteString(route, "workspaceId")! }
        : null;
    case "execution-host":
    case "execution-host-files":
      return getRouteString(route, "hostKind") && getRouteString(route, "hostId")
        ? {
            view: "execution-host",
            hostKind: getRouteString(route, "hostKind")!,
            hostId: getRouteString(route, "hostId")!,
          }
        : null;
    case "agent":
    case "agent-run":
      return getRouteString(route, "agentId")
        ? { view: "agent", agentId: getRouteString(route, "agentId")! }
        : null;
    case "code-explorer": {
      const contentType = getRouteString(route, "contentType");
      if (contentType === "task" && getRouteString(route, "taskId")) {
        return { view: "task", taskId: getRouteString(route, "taskId")! };
      }
      if (contentType === "chat" && getRouteString(route, "chatId")) {
        return { view: "chat", chatId: getRouteString(route, "chatId")! };
      }
      if (contentType === "workspace" && getRouteString(route, "workspaceId")) {
        return { view: "workspace", workspaceId: getRouteString(route, "workspaceId")! };
      }
      if (contentType === "execution-host") {
        const hostKind = getRouteString(route, "hostKind");
        const hostId = getRouteString(route, "hostId");
        if ((hostKind === "local" || hostKind === "mesh" || hostKind === "ssh") && hostId) {
          return { view: "execution-host", hostKind, hostId };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export function renderActiveWorkSidebarItem(itemType: ActiveWorkSidebarItemType) {
  return ({ node }: SidebarItemRenderContext) => (
    <ActiveWorkSidebarItem node={node} itemType={itemType} />
  );
}

export function renderServerSidebarItem(transport: ServerTransportKind) {
  return ({ node }: SidebarItemRenderContext) => (
    <ServerSidebarItem node={node} transport={transport} />
  );
}

export { privateSidebarPresentation };
