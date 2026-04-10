import type { MouseEvent } from "react";
import { appAbsoluteUrl } from "../../lib/public-path";
import type { CodeExplorerTarget, ShellRoute } from "./shell-types";

function buildExplorerHash(path: string, startDirectory?: string): string {
  if (!startDirectory) {
    return path;
  }

  const searchParams = new URLSearchParams({
    startDirectory,
  });
  return `${path}?${searchParams.toString()}`;
}

function buildCodeExplorerHash(target?: CodeExplorerTarget): string {
  if (!target) {
    return "/code-explorer";
  }

  switch (target.contentType) {
    case "workspace":
      return buildExplorerHash(`/code-explorer/workspace/${target.workspaceId}`, target.startDirectory);
    case "loop":
      return buildExplorerHash(`/code-explorer/loop/${target.loopId}`, target.startDirectory);
    case "server":
      return buildExplorerHash(`/code-explorer/server/${target.serverId}`, target.startDirectory);
    case "chat":
      return buildExplorerHash(`/code-explorer/chat/${target.chatId}`, target.startDirectory);
  }
}

export function getHashForShellRoute(route: ShellRoute): string {
  switch (route.view) {
    case "home":
      return "/";
    case "code-explorer":
      return buildCodeExplorerHash(route.target);
    case "loop":
      return `/loop/${route.loopId}`;
    case "loop-files":
      return buildExplorerHash(`/loop-files/${route.loopId}`, route.startDirectory);
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
