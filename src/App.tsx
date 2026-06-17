/**
 * Main application entry with shell-first hash routing.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AppShell, type ShellRoute } from "./components/AppShell";
import { DeviceApprovalScreen } from "./components/DeviceApprovalScreen";
import { PasskeyAuthScreen } from "./components/PasskeyAuthScreen";
import { replaceShellRoute } from "./components/app-shell/shell-navigation";
import { LogLevelInitializer } from "./components/LogLevelInitializer";
import { StandaloneChatTranscriptViewer } from "./components/StandaloneChatTranscriptViewer";
import { AppEventsProvider, ThemePreferenceProvider, usePasskeyAuth } from "./hooks";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

const TASK_FILES_HASH_PREFIX = "/task-files/";
const CODE_EXPLORER_HASH_PREFIX = "/code-explorer";
const CHAT_TRANSCRIPT_HASH_PREFIX = "/chat-transcript/";

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
  const filePath = searchParams.get("filePath")?.trim() || undefined;

  if (hash === CODE_EXPLORER_HASH_PREFIX) {
    return { view: "code-explorer" };
  }

  if (hash.startsWith(`${CODE_EXPLORER_HASH_PREFIX}/`)) {
    const [contentType, entityId] = hash.slice(CODE_EXPLORER_HASH_PREFIX.length + 1).split("/", 2);
    if (contentType === "workspace" && entityId) {
      return { view: "code-explorer", target: { contentType, workspaceId: entityId, startDirectory, filePath } };
    }
    if (contentType === "task" && entityId) {
      return { view: "code-explorer", target: { contentType, taskId: entityId, startDirectory, filePath } };
    }
    if (contentType === "server" && entityId) {
      return { view: "code-explorer", target: { contentType, serverId: entityId, startDirectory, filePath } };
    }
    if (contentType === "chat" && entityId) {
      return { view: "code-explorer", target: { contentType, chatId: entityId, startDirectory, filePath } };
    }
  }

  if (hash.startsWith("/task/")) {
    const taskId = hash.slice(6);
    if (taskId) {
      return { view: "task", taskId };
    }
  }

  if (hash.startsWith(TASK_FILES_HASH_PREFIX)) {
    const taskId = hash.slice(TASK_FILES_HASH_PREFIX.length);
    if (taskId) {
      return { view: "task-files", taskId, startDirectory };
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

  if (hash.startsWith("/server/") && hash.endsWith("/vnc")) {
    const serverId = hash.slice(8, -4);
    if (serverId) {
      return { view: "vnc-session", serverId };
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

  if (hash === "/agents") {
    return { view: "agents" };
  }

  if (hash.startsWith("/new/")) {
    const [kind, scopeId] = hash.slice(5).split("/");
    if (
      kind === "task"
      || kind === "chat"
      || kind === "workspace"
      || kind === "ssh-session"
      || kind === "ssh-server"
      || kind === "ssh-server-chat"
    ) {
      return { view: "compose", kind, scopeId: scopeId || undefined };
    }
  }

  return { view: "home" };
}

function navigateTo(route: ShellRoute) {
  replaceShellRoute(route);
}

function isDeviceApprovalRoute(pathname: string): boolean {
  return pathname.endsWith("/device");
}

function getTranscriptChatIdFromHash(hash: string): string | null {
  if (!hash.startsWith(`#${CHAT_TRANSCRIPT_HASH_PREFIX}`)) {
    return null;
  }

  try {
    return decodeURIComponent(hash.slice(CHAT_TRANSCRIPT_HASH_PREFIX.length + 1));
  } catch (error) {
    console.warn("Ignoring malformed chat transcript route", error);
    return null;
  }
}

export function App() {
  const [route, setRoute] = useState<ShellRoute>(parseHash);
  const passkeyAuth = usePasskeyAuth();
  const transcriptChatId = getTranscriptChatIdFromHash(window.location.hash);
  const canLoadThemePreference = !passkeyAuth.loading
    && (!passkeyAuth.status.passkeyRequired || passkeyAuth.status.authenticated);
  const deviceApprovalRoute = isDeviceApprovalRoute(window.location.pathname)
    ? {
        userCode: new URLSearchParams(window.location.search).get("user_code")?.trim() || undefined,
      }
    : undefined;

  useEffect(() => {
    function handleHashChange() {
      setRoute(parseHash());
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  let content: ReactNode;

  if (passkeyAuth.loading) {
    content = (
      <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4 text-sm text-gray-500 dark:bg-neutral-950 dark:text-gray-400">
        Loading…
      </div>
    );
  } else if (passkeyAuth.status.passkeyRequired && !passkeyAuth.status.authenticated) {
    content = (
      <PasskeyAuthScreen
        loading={passkeyAuth.refreshing}
        authenticating={passkeyAuth.authenticating}
        error={passkeyAuth.error}
        onAuthenticate={passkeyAuth.loginWithPasskey}
      />
    );
  } else if (deviceApprovalRoute) {
    content = <DeviceApprovalScreen userCode={deviceApprovalRoute.userCode} />;
  } else if (transcriptChatId) {
    content = (
      <AppEventsProvider>
        <StandaloneChatTranscriptViewer chatId={transcriptChatId} />
      </AppEventsProvider>
    );
  } else {
    content = (
      <AppEventsProvider>
        <AppShell route={route} onNavigate={navigateTo} passkeyAuth={passkeyAuth} />
      </AppEventsProvider>
    );
  }

  return (
    <LogLevelInitializer>
      <ThemePreferenceProvider canLoadPreference={canLoadThemePreference}>
        {content}
      </ThemePreferenceProvider>
    </LogLevelInitializer>
  );
}

export default App;
