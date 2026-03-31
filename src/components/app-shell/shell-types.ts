import { createLogger } from "../../lib/logger";
import type { Chat, Loop, Workspace } from "../../types";
import type { BadgeVariant } from "../common";

const log = createLogger("AppShell");

export const SIDEBAR_SECTION_STORAGE_KEY = "ralpher.sidebarSectionCollapseState";

export type SidebarSectionId =
  | "workspaces"
  | "loops"
  | "chats"
  | "workspace-ssh"
  | "ssh-servers";

export type SidebarSectionCollapseState = Partial<Record<SidebarSectionId, boolean>>;

export interface SidebarSectionCollapseStateLoadResult {
  state: SidebarSectionCollapseState;
  invalidReason: string | null;
}

export const SIDEBAR_SECTION_IDS: SidebarSectionId[] = [
  "workspaces",
  "loops",
  "chats",
  "workspace-ssh",
  "ssh-servers",
];

export interface WorkspaceSidebarGroup {
  key: string;
  title: string;
  items: Loop[];
}

export interface ChatSidebarGroup {
  key: string;
  title: string;
  items: Chat[];
}

export type ShellRoute =
  | { view: "home" }
  | { view: "settings" }
  | { view: "loop"; loopId: string }
  | { view: "chat"; chatId: string }
  | { view: "ssh"; sshSessionId: string }
  | { view: "workspace"; workspaceId: string }
  | { view: "workspace-files"; workspaceId: string }
  | { view: "workspace-settings"; workspaceId: string }
  | { view: "ssh-server"; serverId: string }
  | { view: "server-arise"; serverId: string }
  | {
      view: "compose";
      kind: "loop" | "chat" | "workspace" | "ssh-session" | "ssh-server";
      scopeId?: string;
    }
  | {
      view: "rebuild-workspace";
      workspaceId: string;
    }
  | {
      view: "restart-workspace";
      workspaceId: string;
    };

export type ComposeKind = Extract<ShellRoute, { view: "compose" }>["kind"];

export function getWorkspaceGroupCollapseKey(sectionId: SidebarSectionId, groupKey: string): string {
  return `${sectionId}:${groupKey}`;
}

export function getSshConnectionModeLabel(mode: "direct" | "dtach" | string): string {
  return mode === "direct" ? "Direct SSH" : "Persistent SSH";
}

export function getProvisioningStatusBadgeVariant(status: string | undefined): BadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "pending":
      return "warning";
    case "cancelled":
      return "default";
    default:
      return "default";
  }
}

export function groupSidebarItemsByWorkspace(
  items: Loop[],
  workspaces: readonly Workspace[],
): WorkspaceSidebarGroup[] {
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceOrder = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  const groups = new Map<string, WorkspaceSidebarGroup & { order: number }>();

  for (const item of items) {
    const workspace = workspacesById.get(item.config.workspaceId);
    const key = workspace?.id ?? `missing:${item.config.workspaceId ?? item.config.id}`;
    const group = groups.get(key) ?? {
      key,
      title: workspace?.name ?? "Unknown workspace",
      order: workspace ? (workspaceOrder.get(workspace.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.title.localeCompare(right.title);
    })
    .map(({ key, title, items: groupedItems }) => ({ key, title, items: groupedItems }));
}

export function groupSidebarChatsByWorkspace(
  chats: Chat[],
  workspaces: readonly Workspace[],
): ChatSidebarGroup[] {
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaceOrder = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  const groups = new Map<string, ChatSidebarGroup & { order: number }>();

  for (const chat of chats) {
    const workspace = workspacesById.get(chat.config.workspaceId);
    const key = workspace?.id ?? `missing:${chat.config.workspaceId ?? chat.config.id}`;
    const group = groups.get(key) ?? {
      key,
      title: workspace?.name ?? "Unknown workspace",
      order: workspace ? (workspaceOrder.get(workspace.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
      items: [],
    };
    group.items.push(chat);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.title.localeCompare(right.title);
    })
    .map(({ key, title, items }) => ({
      key,
      title,
      items: items.sort((left, right) => right.config.updatedAt.localeCompare(left.config.updatedAt)),
    }));
}

export function isDesktopShellViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(min-width: 1024px)").matches;
}

function getSidebarSectionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Sidebar section storage is unavailable", { error: String(error) });
    return null;
  }
}

export function loadSidebarSectionCollapseState(): SidebarSectionCollapseStateLoadResult {
  const storage = getSidebarSectionStorage();
  if (!storage) {
    return {
      state: {},
      invalidReason: null,
    };
  }

  const raw = storage.getItem(SIDEBAR_SECTION_STORAGE_KEY);
  if (!raw) {
    return {
      state: {},
      invalidReason: null,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid sidebar section state payload");
    }

    const parsedState = parsed as Record<string, unknown>;
    const sanitizedState = SIDEBAR_SECTION_IDS.reduce<SidebarSectionCollapseState>((state, sectionId) => {
      if (typeof parsedState[sectionId] === "boolean") {
        state[sectionId] = parsedState[sectionId] as boolean;
      }
      return state;
    }, {});
    return {
      state: sanitizedState,
      invalidReason: null,
    };
  } catch (error) {
    return {
      state: {},
      invalidReason: String(error),
    };
  }
}

export function saveSidebarSectionCollapseState(state: SidebarSectionCollapseState): void {
  const storage = getSidebarSectionStorage();
  if (!storage) {
    return;
  }

  const persistedState = SIDEBAR_SECTION_IDS.reduce<SidebarSectionCollapseState>((result, sectionId) => {
    if (typeof state[sectionId] === "boolean") {
      result[sectionId] = state[sectionId];
    }
    return result;
  }, {});

  try {
    storage.setItem(SIDEBAR_SECTION_STORAGE_KEY, JSON.stringify(persistedState));
  } catch (error) {
    log.warn("Failed to persist sidebar section state", { error: String(error) });
  }
}
