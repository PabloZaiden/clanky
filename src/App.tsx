/**
 * Main application entry with shell-first hash routing.
 */

import { useEffect, useState } from "react";
import { AppShell, type ShellRoute } from "./components/AppShell";
import { LogLevelInitializer } from "./components/LogLevelInitializer";
import "./index.css";

function parseHash(): ShellRoute {
  const hash = window.location.hash.slice(1);

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
      || kind === "workspace"
      || kind === "ssh-session"
      || kind === "ssh-server"
    ) {
      return { view: "compose", kind, scopeId: scopeId || undefined };
    }
  }

  return { view: "home" };
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
    case "workspace":
      window.location.hash = `/workspace/${route.workspaceId}`;
      return;
    case "workspace-settings":
      window.location.hash = `/workspace-settings/${route.workspaceId}`;
      return;
    case "ssh-server":
      window.location.hash = `/server/${route.serverId}`;
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
