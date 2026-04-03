import type { MouseEvent } from "react";
import { appAbsoluteUrl } from "../../lib/public-path";
import type { ShellRoute } from "./shell-types";

function buildExplorerHash(path: string, startDirectory?: string): string {
  if (!startDirectory) {
    return path;
  }

  const searchParams = new URLSearchParams({
    startDirectory,
  });
  return `${path}?${searchParams.toString()}`;
}

export function getHashForShellRoute(route: ShellRoute): string {
  switch (route.view) {
    case "home":
      return "/";
    case "loop":
      return `/loop/${route.loopId}`;
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

export function isModifiedNavigationClick(event: MouseEvent<HTMLElement>): boolean {
  return event.metaKey || event.ctrlKey;
}
