/**
 * Main application entry with shell-first hash routing.
 */

import { useEffect, useState } from "react";
import { AppShell, type ShellRoute } from "./components/AppShell";
import { PasskeyAuthScreen } from "./components/PasskeyAuthScreen";
import { getHashForShellRoute } from "./components/app-shell/shell-navigation";
import { LogLevelInitializer } from "./components/LogLevelInitializer";
import { usePasskeyAuth } from "./hooks";
import "./index.css";

const LOOP_FILES_HASH_PREFIX = "/loop-files/";

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

  if (hash.startsWith(LOOP_FILES_HASH_PREFIX)) {
    const loopId = hash.slice(LOOP_FILES_HASH_PREFIX.length);
    if (loopId) {
      return { view: "loop-files", loopId, startDirectory };
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

function navigateTo(route: ShellRoute) {
  window.location.hash = getHashForShellRoute(route);
}

export function App() {
  const [route, setRoute] = useState<ShellRoute>(parseHash);
  const passkeyAuth = usePasskeyAuth();

  useEffect(() => {
    function handleHashChange() {
      setRoute(parseHash());
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  if (passkeyAuth.loading) {
    return (
      <LogLevelInitializer>
        <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4 text-sm text-gray-500 dark:bg-neutral-950 dark:text-gray-400">
          Loading…
        </div>
      </LogLevelInitializer>
    );
  }

  if (passkeyAuth.status.passkeyRequired && !passkeyAuth.status.authenticated) {
    return (
      <LogLevelInitializer>
        <PasskeyAuthScreen
          basicAuthEnabled={passkeyAuth.basicAuthEnabled}
          loading={passkeyAuth.refreshing}
          authenticating={passkeyAuth.authenticating}
          error={passkeyAuth.error}
          onAuthenticate={passkeyAuth.loginWithPasskey}
        />
      </LogLevelInitializer>
    );
  }

  return (
    <LogLevelInitializer>
      <AppShell route={route} onNavigate={navigateTo} passkeyAuth={passkeyAuth} />
    </LogLevelInitializer>
  );
}

export default App;
