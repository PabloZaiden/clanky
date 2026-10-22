import type { ReactNode } from "react";
import { Badge, formatStatusLabel } from "@pablozaiden/webapp/web";
import type {
  ActionMenuItem,
  SidebarItemRenderContext,
  SidebarNode,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import {
  isEffectivelyPrivate,
  PRIVATE_SIDEBAR_BADGE,
  shouldObscurePrivateItem,
  type PrivateEntity,
  type PrivateSidebarNode,
} from "../../lib/private-items";
import { usePrivateItemReveal } from "../../hooks/usePrivateItemReveal";
import { getRouteString } from "./route-fields";
import {
  ActiveWorkSidebarItem,
  type ActiveWorkSidebarItemType,
} from "./active-work-sidebar-item";
import {
  ServerSidebarItem,
  type ServerTransportKind,
} from "./server-sidebar-item";
import { WorkspaceIdentity } from "../common";
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

function DefaultPrivateSidebarItem({ node }: SidebarItemRenderContext) {
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
  const isTextBadge = node.badgeAppearance === "text";

  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
      </span>
      {node.badge ? (
        <Badge
          variant={node.badgeVariant}
          appearance={isTextBadge ? "text" : "pill"}
          className={[
            "wapp-sidebar-badge",
            isTextBadge ? "wapp-sidebar-badge-text" : "",
          ].filter(Boolean).join(" ")}
          title={badgeLabel}
          aria-label={badgeLabel}
        >
          {isTextBadge ? badgeLabel : " "}
        </Badge>
      ) : null}
    </>
  );
}

type PrivateSidebarActivationGate = {
  canActivate: boolean;
};

function PrivateSidebarReveal({
  children,
  activationGate,
}: {
  children: ReactNode;
  activationGate: PrivateSidebarActivationGate;
}) {
  const reveal = usePrivateItemReveal(true);
  activationGate.canActivate = reveal.canActivate;

  return (
    <>
      {children}
      <span
        aria-hidden="true"
        className={`clanky-private-sidebar-reveal ${reveal.stateClassName}`.trim()}
        onPointerEnter={(event) => {
          activationGate.canActivate = false;
          reveal.onPointerEnter(event);
        }}
        onPointerLeave={(event) => {
          activationGate.canActivate = false;
          reveal.onPointerLeave(event);
        }}
      />
    </>
  );
}

export function privateSidebarPresentation<T extends SidebarNode>(
  node: T,
  privateHidden: boolean,
  contextActions: ActionMenuItem[] = node.actions ?? [],
): T & PrivateSidebarNode {
  if (!privateHidden) {
    return {
      ...node,
      privateHidden: false,
    };
  }

  const originalRender = node.render;
  const activationGate: PrivateSidebarActivationGate = { canActivate: false };

  return {
    ...node,
    onActivate: () => activationGate.canActivate,
    contextActions,
    badge: PRIVATE_SIDEBAR_BADGE,
    badgeVariant: "disabled",
    privateHidden: true,
    render: (context) => (
      <PrivateSidebarReveal activationGate={activationGate}>
        {originalRender?.(context) ?? <DefaultPrivateSidebarItem {...context} />}
      </PrivateSidebarReveal>
    ),
  };
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
    case "scratchpad":
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

export function renderActiveWorkSidebarItem(
  itemType: ActiveWorkSidebarItemType,
  lastInteractionAt: string,
  workspace?: Workspace,
) {
  return ({ node }: SidebarItemRenderContext) => (
    <ActiveWorkSidebarItem
      node={node}
      itemType={itemType}
      lastInteractionAt={lastInteractionAt}
      workspace={workspace}
    />
  );
}

export function renderWorkspaceSidebarItem(workspace: Workspace) {
  return () => (
    <WorkspaceIdentity
      workspace={workspace}
      className="text-sm text-gray-900 dark:text-gray-100"
    />
  );
}

export function renderServerSidebarItem(transport: ServerTransportKind) {
  return ({ node }: SidebarItemRenderContext) => (
    <ServerSidebarItem node={node} transport={transport} />
  );
}
