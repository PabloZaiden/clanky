import type { MouseEvent } from "react";
import { appAbsoluteUrl } from "../../lib/public-path";
import type { CodeExplorerTarget, ShellRoute } from "./shell-types";

export type ShellShortcutAction =
  | "new-task"
  | "new-chat"
  | "new-ssh-session"
  | "settings"
  | "code-explorer"
  | "sidebar-search";

interface ShellShortcutDefinition {
  action: ShellShortcutAction;
  key: string;
  labelKey: string;
  route?: ShellRoute;
}

export const SHELL_SHORTCUTS: Record<ShellShortcutAction, ShellShortcutDefinition> = {
  "new-task": {
    action: "new-task",
    key: "l",
    labelKey: "L",
    route: { view: "compose", kind: "task" },
  },
  "new-chat": {
    action: "new-chat",
    key: "c",
    labelKey: "C",
    route: { view: "compose", kind: "chat" },
  },
  "new-ssh-session": {
    action: "new-ssh-session",
    key: "s",
    labelKey: "S",
    route: { view: "compose", kind: "ssh-session" },
  },
  settings: {
    action: "settings",
    key: ",",
    labelKey: ",",
    route: { view: "settings" },
  },
  "code-explorer": {
    action: "code-explorer",
    key: "e",
    labelKey: "E",
    route: { view: "code-explorer" },
  },
  "sidebar-search": {
    action: "sidebar-search",
    key: "f",
    labelKey: "F",
  },
};

export function getShellShortcutLabel(action: ShellShortcutAction): string {
  return `Ctrl/Cmd+Shift+${SHELL_SHORTCUTS[action].labelKey}`;
}

export function getShellShortcutTitle(action: ShellShortcutAction, title: string): string {
  return `${title} (${getShellShortcutLabel(action)})`;
}

export function getShellShortcutForKeyboardEvent(event: KeyboardEvent): ShellShortcutDefinition | null {
  if (event.defaultPrevented || event.altKey || !event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }

  const eventKey = event.key.toLowerCase();
  return Object.values(SHELL_SHORTCUTS).find((shortcut) => shortcut.key === eventKey) ?? null;
}

function buildRouteHash(view: string, params: Record<string, string | undefined> = {}): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      searchParams.set(key, value);
    }
  }
  return `/${view}${searchParams.size ? `?${searchParams.toString()}` : ""}`;
}

function buildCodeExplorerHash(target?: CodeExplorerTarget): string {
  if (!target) {
    return "/code-explorer";
  }

  switch (target.contentType) {
    case "workspace":
      return buildRouteHash("code-explorer", {
        contentType: "workspace",
        workspaceId: target.workspaceId,
        startDirectory: target.startDirectory,
        filePath: target.filePath,
      });
    case "task":
      return buildRouteHash("code-explorer", {
        contentType: "task",
        taskId: target.taskId,
        startDirectory: target.startDirectory,
        filePath: target.filePath,
      });
    case "server":
      return buildRouteHash("code-explorer", {
        contentType: "server",
        serverId: target.serverId,
        startDirectory: target.startDirectory,
        filePath: target.filePath,
      });
    case "chat":
      return buildRouteHash("code-explorer", {
        contentType: "chat",
        chatId: target.chatId,
        startDirectory: target.startDirectory,
        filePath: target.filePath,
      });
  }
}

export function getHashForShellRoute(route: ShellRoute): string {
  switch (route.view) {
    case "home":
      return "/home";
    case "code-explorer":
      return buildCodeExplorerHash(route.target);
    case "task":
      return buildRouteHash("task", { taskId: route.taskId });
    case "task-files":
      return buildRouteHash("task-files", { taskId: route.taskId, startDirectory: route.startDirectory });
    case "ssh":
      return buildRouteHash("ssh", { sshSessionId: route.sshSessionId });
    case "chat":
      return buildRouteHash("chat", { chatId: route.chatId });
    case "agent":
      return buildRouteHash("agent", { agentId: route.agentId });
    case "agent-run":
      return buildRouteHash("agent-run", { agentId: route.agentId, runId: route.runId });
    case "workspace":
      return buildRouteHash("workspace", { workspaceId: route.workspaceId });
    case "workspace-files":
      return buildRouteHash("workspace-files", { workspaceId: route.workspaceId, startDirectory: route.startDirectory });
    case "workspace-settings":
      return buildRouteHash("workspace-settings", { workspaceId: route.workspaceId });
    case "ssh-server":
      return buildRouteHash("ssh-server", { serverId: route.serverId });
    case "vnc-session":
      return buildRouteHash("vnc-session", { serverId: route.serverId });
    case "ssh-server-settings":
      return buildRouteHash("ssh-server-settings", { serverId: route.serverId });
    case "server-files":
      return buildRouteHash("server-files", { serverId: route.serverId, startDirectory: route.startDirectory });
    case "server-arise":
      return buildRouteHash("server-arise", { serverId: route.serverId });
    case "settings":
      return "/settings";
    case "agents":
      return buildRouteHash("agents", { workspaceId: route.workspaceId });
    case "rebuild-workspace":
      return buildRouteHash("rebuild-workspace", { workspaceId: route.workspaceId });
    case "restart-workspace":
      return buildRouteHash("restart-workspace", { workspaceId: route.workspaceId });
    case "compose":
      return buildRouteHash("compose", {
        kind: route.kind,
        scopeId: route.scopeId,
        workspaceId: route.workspaceId,
        serverId: route.serverId,
      });
  }
}

export function getShellRouteUrl(route: ShellRoute): string {
  return appAbsoluteUrl(`/#${getHashForShellRoute(route)}`);
}

export function replaceHashRoute(hash: string) {
  const normalizedHash = hash.startsWith("#") ? hash : `#${hash}`;
  if (window.location.hash === normalizedHash) {
    return;
  }

  const previousUrl = window.location.href;
  window.history.replaceState(window.history.state, "", normalizedHash);
  window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: previousUrl, newURL: window.location.href }));
}

export function replaceShellRoute(route: ShellRoute) {
  replaceHashRoute(getHashForShellRoute(route));
}

export function isModifiedNavigationClick(event: MouseEvent<HTMLElement>): boolean {
  return event.metaKey || event.ctrlKey;
}
