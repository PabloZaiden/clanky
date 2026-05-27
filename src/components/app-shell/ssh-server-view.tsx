import { useEffect, useState } from "react";
import type { Chat, CreateSshServerChatRequest, SshServer, SshServerSession } from "../../types";
import { ActionMenu, Badge, Button, GearIcon, insertPinActionItem } from "../common";
import type { ShellRoute } from "./shell-types";
import type { SidebarPinningState } from "./sidebar-pins";
import { ShellPanel, SummaryCard } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";
import { buildSshServerActionItems } from "./shell-action-items";

export function SshServerView({
  server,
  sessions,
  chats,
  headerOffsetClassName,
  onNavigate,
  onCreateChat,
  onOpenSettings,
  sidebarPinning,
}: {
  server: SshServer;
  sessions: SshServerSession[];
  chats: Chat[];
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
  onCreateChat: (serverId: string, request: CreateSshServerChatRequest) => Promise<Chat | null>;
  onOpenSettings: () => void;
  sidebarPinning: SidebarPinningState;
}) {
  const defaultDirectory = server.config.repositoriesBasePath ?? "~";
  const [showChatForm, setShowChatForm] = useState(false);
  const [chatName, setChatName] = useState("");
  const [directory, setDirectory] = useState(defaultDirectory);
  const [providerID, setProviderID] = useState<"copilot" | "opencode">("copilot");
  const [modelID, setModelID] = useState("gpt-5.5");
  const [creatingChat, setCreatingChat] = useState(false);
  const serverPinnedItem = { kind: "ssh-server" as const, id: server.config.id };
  const actionItems = insertPinActionItem(buildSshServerActionItems({ server, onNavigate }), {
      id: "toggle-sidebar-pin",
      label: sidebarPinning.isPinned(serverPinnedItem) ? "Unpin from sidebar" : "Pin to sidebar",
      onClick: () => sidebarPinning.togglePinned(serverPinnedItem),
  });

  useEffect(() => {
    setShowChatForm(false);
    setChatName("");
    setDirectory(defaultDirectory);
    setProviderID("copilot");
    setModelID("gpt-5.5");
    setCreatingChat(false);
  }, [server.config.id, defaultDirectory]);

  return (
    <ShellPanel
      eyebrow="SSH server"
      title={server.config.name}
      description={`${server.config.username}@${server.config.address}`}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      badges={(
        <Badge variant="default" size="sm">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </Badge>
      )}
      actions={(
        <>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowChatForm((value) => !value)}
            className="min-h-[44px] sm:min-h-0"
          >
            Start chat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            title="SSH Server Settings"
            aria-label="Open SSH server settings"
            className="min-h-[44px] min-w-[44px] px-1.5 sm:min-h-0 sm:min-w-0"
            icon={<GearIcon size="h-5 w-5" />}
          >
            {null}
          </Button>
          <ActionMenu items={actionItems} ariaLabel={`SSH server actions for ${server.config.name}`} />
        </>
      )}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <SummaryCard label="Address" value={server.config.address} meta="Stored without credentials on the server." />
        <SummaryCard label="Username" value={server.config.username} meta="Used for standalone SSH sessions." />
        <SummaryCard label="Saved sessions" value={sessions.length} meta="Standalone terminals attached to this host." />
        {server.config.repositoriesBasePath && (
          <SummaryCard label="Repositories base path" value={server.config.repositoriesBasePath} meta="Default base path for automatic provisioning." />
        )}
      </div>

      {showChatForm && (
        <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-neutral-900">
          <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">New remote chat</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Name
              <input
                value={chatName}
                onChange={(event) => setChatName(event.target.value)}
                placeholder="Remote investigation"
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-700 dark:bg-neutral-950 dark:text-gray-100"
              />
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Remote directory
              <input
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-gray-900 dark:border-gray-700 dark:bg-neutral-950 dark:text-gray-100"
              />
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Provider
              <select
                value={providerID}
                onChange={(event) => setProviderID(event.target.value as "copilot" | "opencode")}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-700 dark:bg-neutral-950 dark:text-gray-100"
              >
                <option value="copilot">Copilot</option>
                <option value="opencode">OpenCode</option>
              </select>
            </label>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Model
              <input
                value={modelID}
                onChange={(event) => setModelID(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-700 dark:bg-neutral-950 dark:text-gray-100"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowChatForm(false)} disabled={creatingChat}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              loading={creatingChat}
              disabled={creatingChat || !directory.trim() || !modelID.trim()}
              onClick={() => {
                void (async () => {
                  setCreatingChat(true);
                  try {
                    const chat = await onCreateChat(server.config.id, {
                      name: chatName.trim() || undefined,
                      directory: directory.trim(),
                      model: { providerID, modelID: modelID.trim(), variant: "" },
                      autoApprovePermissions: true,
                    });
                    if (chat) {
                      onNavigate({ view: "chat", chatId: chat.config.id });
                    }
                  } finally {
                    setCreatingChat(false);
                  }
                })();
              }}
            >
              Create chat
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
        <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Remote chats</h2>
        <div className="space-y-2">
          {chats.length === 0 ? (
            <EmptySection message="No remote chats yet for this SSH server." />
          ) : (
            chats.map((chat) => (
              <button
                key={chat.config.id}
                type="button"
                onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
                className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {chat.config.name}
                  </span>
                  <span className="mt-1 block truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                    {chat.config.directory}
                  </span>
                </span>
                <Badge variant={chat.state.connectionStatus === "connected" ? "success" : "default"}>
                  {chat.state.connectionStatus ?? "disconnected"}
                </Badge>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
        <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Standalone sessions</h2>
        <div className="space-y-2">
          {sessions.length === 0 ? (
            <EmptySection message="No standalone sessions yet for this SSH server." />
          ) : (
            sessions.map((session) => (
              <button
                key={session.config.id}
                type="button"
                onClick={() => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {session.config.name}
                  </span>
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                    {session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                  </span>
                </span>
                <Badge
                  variant={
                    session.state.status === "connected"
                      ? "success"
                      : session.state.status === "failed"
                        ? "error"
                        : "default"
                  }
                >
                  {session.state.status}
                </Badge>
              </button>
            ))
          )}
        </div>
      </div>
    </ShellPanel>
  );
}
