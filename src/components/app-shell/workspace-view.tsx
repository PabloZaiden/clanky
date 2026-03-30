import type { Chat, SshServer, Workspace } from "../../types";
import { findRegisteredSshServer } from "../../types/settings";
import type { useChats, useLoops, useSshSessions } from "../../hooks";
import { getLoopStatusLabel } from "../../utils";
import {
  ActionMenu,
  Button,
  GearIcon,
  StatusBadge,
  type ActionMenuItem,
  getChatStatusBadgeVariant,
  getStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
} from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";

function getWorkspaceHeaderServerLabel(
  workspace: Workspace,
  registeredSshServers: readonly SshServer[],
): string {
  if (workspace.serverSettings.agent.transport === "stdio") {
    return "stdio";
  }

  const hostname = workspace.serverSettings.agent.hostname.trim() || "127.0.0.1";
  const port = workspace.serverSettings.agent.port ?? 22;
  const registeredServer = findRegisteredSshServer(hostname, registeredSshServers);
  const serverLabel = registeredServer?.config.name ?? hostname;

  return port === 22 ? serverLabel : `${serverLabel}:${port}`;
}

export function WorkspaceView({
  workspace,
  relatedLoops,
  relatedChats,
  relatedSessions,
  registeredSshServers,
  headerOffsetClassName,
  onOpenSettings,
  onNavigate,
}: {
  workspace: Workspace;
  relatedLoops: ReturnType<typeof useLoops>["loops"];
  relatedChats: ReturnType<typeof useChats>["chats"];
  relatedSessions: ReturnType<typeof useSshSessions>["sessions"];
  registeredSshServers: readonly SshServer[];
  headerOffsetClassName?: string;
  onOpenSettings: () => void;
  onNavigate: (route: ShellRoute) => void;
}) {
  const workspaceSshEnabled = workspace.serverSettings.agent.transport === "ssh";
  const isAutoProvisioned = Boolean(workspace.sourceDirectory);
  const serverLabel = getWorkspaceHeaderServerLabel(workspace, registeredSshServers);
  const createActionItems: ActionMenuItem[] = [
    {
      label: "New Loop",
      onClick: () => onNavigate({ view: "compose", kind: "loop", scopeId: workspace.id }),
    },
    {
      label: "New Chat",
      onClick: () => onNavigate({ view: "compose", kind: "chat", scopeId: workspace.id }),
    },
    ...(workspaceSshEnabled
      ? [{
          label: "New SSH Session",
          onClick: () => onNavigate({ view: "compose", kind: "ssh-session", scopeId: workspace.id }),
        }]
      : []),
  ];

  return (
    <ShellPanel
      eyebrow="Workspace"
      title={workspace.name}
      description={serverLabel}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
          {isAutoProvisioned && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onNavigate({ view: "restart-workspace", workspaceId: workspace.id })}
                title="Restart devbox"
                className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0"
              >
                Restart
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onNavigate({ view: "rebuild-workspace", workspaceId: workspace.id })}
                title="Rebuild devbox"
                className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0"
              >
                Rebuild
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            title="Workspace Settings"
            aria-label="Open workspace settings"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 px-1.5"
            icon={<GearIcon size="h-5 w-5" />}
          >
            {null}
          </Button>
          <ActionMenu items={createActionItems} ariaLabel={`Create items in workspace ${workspace.name}`} />
        </>
      )}
    >
      <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
            Workspace activity
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Unified counts for loops, chats, and SSH sessions in this workspace.
          </p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-neutral-900">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Loops</p>
            <p className="mt-2 text-2xl font-semibold text-gray-950 dark:text-gray-100">{relatedLoops.length}</p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Loops assigned to this workspace.</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-neutral-900">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Chats</p>
            <p className="mt-2 text-2xl font-semibold text-gray-950 dark:text-gray-100">{relatedChats.length}</p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Persistent chat sessions in this workspace.</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-neutral-900">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
              SSH sessions
            </p>
            <p className="mt-2 text-2xl font-semibold text-gray-950 dark:text-gray-100">{relatedSessions.length}</p>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {workspaceSshEnabled
                ? "Saved SSH sessions for this workspace."
                : "Saved SSH sessions stay at 0 until this workspace uses SSH transport."}
            </p>
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Loops</h2>
          <div className="space-y-2">
            {relatedLoops.length === 0 ? (
              <EmptySection message="No loops in this workspace yet." />
            ) : (
              relatedLoops.map((loop) => {
                const route: ShellRoute = { view: "loop", loopId: loop.config.id };
                return (
                  <button
                    key={loop.config.id}
                    type="button"
                    onClick={() => onNavigate(route)}
                    className="flex min-w-0 w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {loop.config.name}
                      </span>
                      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                        Loop
                      </span>
                    </span>
                    <StatusBadge className="ml-auto shrink-0" variant={getStatusBadgeVariant(loop.state.status)}>
                      {getLoopStatusLabel(loop)}
                    </StatusBadge>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Chats</h2>
          <div className="space-y-2">
            {relatedChats.length === 0 ? (
              <EmptySection message="No chats in this workspace yet." />
            ) : (
              relatedChats.map((chat: Chat) => (
                <button
                  key={chat.config.id}
                  type="button"
                  onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
                  className="flex min-w-0 w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {chat.config.name}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                      Chat
                    </span>
                  </span>
                  <StatusBadge className="ml-auto shrink-0" variant={getChatStatusBadgeVariant(chat.state.status)}>
                    {chat.state.status}
                  </StatusBadge>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">SSH sessions</h2>
          <div className="space-y-2">
            {relatedSessions.length === 0 ? (
              <EmptySection
                message={workspaceSshEnabled
                  ? "No SSH sessions yet for this workspace."
                  : "This workspace is not configured for SSH transport."}
              />
            ) : (
              relatedSessions.map((session) => (
                <button
                  key={session.config.id}
                  type="button"
                  onClick={() => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                  className="flex min-w-0 w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {session.config.name}
                    </span>
                    <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                      {session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                    </span>
                  </span>
                  <StatusBadge
                    className="ml-auto shrink-0"
                    variant={getSshSessionStatusBadgeVariant(session.state.status)}
                  >
                    {getSshSessionStatusLabel(session.state.status)}
                  </StatusBadge>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </ShellPanel>
  );
}
