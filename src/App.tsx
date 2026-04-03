/**
 * Main application entry with shell-first hash routing.
 */

import { useEffect, useState } from "react";
import { AppShell, type ShellRoute } from "./components/AppShell";
import { LogLevelInitializer } from "./components/LogLevelInitializer";
import "./index.css";

function parseHashPath(hash: string): { path: string; searchParams: URLSearchParams } {
  const [path = "", query = ""] = hash.split("?", 2);
  return {
    path,
    searchParams: new URLSearchParams(query),
  };
}

function parseHash(): ShellRoute {
  const { path: hash, searchParams } = parseHashPath(window.location.hash.slice(1));
  const startDirectory = searchParams.get("startDirectory")?.trim() || undefined;

  if (hash.startsWith("/loop/")) {
    const loopId = hash.slice(6);
    if (loopId) {
      return { view: "loop", loopId };
    }
  }

  if (hash.startsWith("/ssh/")) {
    const sshSessionId = hash.slice(5);
    if (sshSessionId) {
      return { view: "ssh", sshSessionId };
    }
  }

  if (hash.startsWith("/chat/")) {
    const chatId = hash.slice(6);
    if (chatId) {
      return { view: "chat", chatId };
    }
  }

  if (hash.startsWith("/rebuild-workspace/")) {
    const workspaceId = hash.slice(19);
    if (workspaceId) {
      return { view: "rebuild-workspace", workspaceId };
    }
  }

  if (hash.startsWith("/restart-workspace/")) {
    const workspaceId = hash.slice(19);
    if (workspaceId) {
      return { view: "restart-workspace", workspaceId };
    }
  }

  if (hash.startsWith("/workspace-settings/")) {
    const workspaceId = hash.slice(20);
    if (workspaceId) {
      return { view: "workspace-settings", workspaceId };
    }
  }

  if (hash.startsWith("/workspace-files/")) {
    const workspaceId = hash.slice(17);
    if (workspaceId) {
      return { view: "workspace-files", workspaceId, startDirectory };
    }
  }

  if (hash.startsWith("/server-settings/")) {
    const serverId = hash.slice(17);
    if (serverId) {
      return { view: "ssh-server-settings", serverId };
    }
  }

  if (hash.startsWith("/workspace/")) {
    const workspaceId = hash.slice(11);
    if (workspaceId) {
      return { view: "workspace", workspaceId };
    }
  }

  if (hash.startsWith("/server/")) {
    const serverId = hash.slice(8);
    if (serverId) {
      return { view: "ssh-server", serverId };
    }
  }

  if (hash.startsWith("/server-files/")) {
    const serverId = hash.slice(14);
    if (serverId) {
      return { view: "server-files", serverId, startDirectory };
    }
  }

  if (hash.startsWith("/server-arise/")) {
    const serverId = hash.slice(14);
    if (serverId) {
      return { view: "server-arise", serverId };
    }
  }

  if (hash === "/settings") {
    return { view: "settings" };
  }

  if (hash.startsWith("/new/")) {
    const [kind, scopeId] = hash.slice(5).split("/");
    if (
      kind === "loop"
      || kind === "chat"
      || kind === "workspace"
      || kind === "ssh-session"
      || kind === "ssh-server"
    ) {
      return { view: "compose", kind, scopeId: scopeId || undefined };
    }
  }

  return { view: "home" };
}

function buildExplorerHash(path: string, startDirectory?: string): string {
  if (!startDirectory) {
    return path;
  }

  const searchParams = new URLSearchParams({
    startDirectory,
  });
  return `${path}?${searchParams.toString()}`;
}

function navigateTo(route: ShellRoute) {
  switch (route.view) {
    case "home":
      window.location.hash = "/";
      return;
    case "loop":
      window.location.hash = `/loop/${route.loopId}`;
      return;
    case "ssh":
      window.location.hash = `/ssh/${route.sshSessionId}`;
      return;
    case "chat":
      window.location.hash = `/chat/${route.chatId}`;
      return;
    case "workspace":
      window.location.hash = `/workspace/${route.workspaceId}`;
      return;
    case "workspace-files":
      window.location.hash = buildExplorerHash(`/workspace-files/${route.workspaceId}`, route.startDirectory);
      return;
    case "workspace-settings":
      window.location.hash = `/workspace-settings/${route.workspaceId}`;
      return;
    case "ssh-server":
      window.location.hash = `/server/${route.serverId}`;
      return;
    case "ssh-server-settings":
      window.location.hash = `/server-settings/${route.serverId}`;
      return;
    case "server-files":
      window.location.hash = buildExplorerHash(`/server-files/${route.serverId}`, route.startDirectory);
      return;
    case "server-arise":
      window.location.hash = `/server-arise/${route.serverId}`;
      return;
    case "settings":
      window.location.hash = "/settings";
      return;
    case "rebuild-workspace":
      window.location.hash = `/rebuild-workspace/${route.workspaceId}`;
      return;
    case "restart-workspace":
      window.location.hash = `/restart-workspace/${route.workspaceId}`;
      return;
    case "compose":
      window.location.hash = route.scopeId
        ? `/new/${route.kind}/${route.scopeId}`
        : `/new/${route.kind}`;
      return;
  }
}

export function App() {
  const [route, setRoute] = useState<ShellRoute>(parseHash);

  useEffect(() => {
    function handleHashChange() {
      setRoute(parseHash());
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return (
    <LogLevelInitializer>
      <AppShell route={route} onNavigate={navigateTo} />
    </LogLevelInitializer>
  );
}

export default App;
