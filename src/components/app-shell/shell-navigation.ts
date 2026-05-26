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

function buildExplorerHash(path: string, startDirectory?: string, filePath?: string): string {
  if (!startDirectory && !filePath) {
    return path;
  }

  const searchParams = new URLSearchParams();
  if (startDirectory) {
    searchParams.set("startDirectory", startDirectory);
  }
  if (filePath) {
    searchParams.set("filePath", filePath);
  }
  return `${path}?${searchParams.toString()}`;
}

function buildCodeExplorerHash(target?: CodeExplorerTarget): string {
  if (!target) {
    return "/code-explorer";
  }

  switch (target.contentType) {
    case "workspace":
      return buildExplorerHash(`/code-explorer/workspace/${target.workspaceId}`, target.startDirectory, target.filePath);
    case "task":
      return buildExplorerHash(`/code-explorer/task/${target.taskId}`, target.startDirectory, target.filePath);
    case "server":
      return buildExplorerHash(`/code-explorer/server/${target.serverId}`, target.startDirectory, target.filePath);
    case "chat":
      return buildExplorerHash(`/code-explorer/chat/${target.chatId}`, target.startDirectory, target.filePath);
  }
}

export function getHashForShellRoute(route: ShellRoute): string {
  switch (route.view) {
    case "home":
      return "/";
    case "code-explorer":
      return buildCodeExplorerHash(route.target);
    case "task":
      return `/task/${route.taskId}`;
    case "task-files":
      return buildExplorerHash(`/task-files/${route.taskId}`, route.startDirectory);
    case "ssh":
      return `/ssh/${route.sshSessionId}`;
    case "chat":
      return `/chat/${route.chatId}`;
    case "workspace":
      return `/workspace/${route.workspaceId}`;
    case "workspace-files":
      return buildExplorerHash(`/workspace-files/${route.workspaceId}`, route.startDirectory);
    case "workspace-settings":
      return `/workspace-settings/${route.workspaceId}`;
    case "ssh-server":
      return `/server/${route.serverId}`;
    case "ssh-server-settings":
      return `/server-settings/${route.serverId}`;
    case "server-files":
      return buildExplorerHash(`/server-files/${route.serverId}`, route.startDirectory);
    case "server-arise":
      return `/server-arise/${route.serverId}`;
    case "settings":
      return "/settings";
    case "rebuild-workspace":
      return `/rebuild-workspace/${route.workspaceId}`;
    case "restart-workspace":
      return `/restart-workspace/${route.workspaceId}`;
    case "compose":
      return route.scopeId
        ? `/new/${route.kind}/${route.scopeId}`
        : `/new/${route.kind}`;
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
