import type { Chat, SshServer, Workspace } from "../../types";
import { findRegisteredSshServer } from "../../types/settings";
import type { useChats, useLoops, useSshSessions } from "../../hooks";
import { getLoopStatusPill, isWorkspaceHistoryLoop } from "../../utils";
import {
  ActionMenu,
  Button,
  GearIcon,
  StatusBadge,
  getChatStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
} from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";
import { useWorkspaceGitHubUrl } from "./use-workspace-github-url";
import { buildWorkspaceActionItems } from "./shell-action-items";

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
  onPullLatestChanges,
  pullingLatestChanges,
  onNavigate,
}: {
  workspace: Workspace;
  relatedLoops: ReturnType<typeof useLoops>["loops"];
  relatedChats: ReturnType<typeof useChats>["chats"];
  relatedSessions: ReturnType<typeof useSshSessions>["sessions"];
  registeredSshServers: readonly SshServer[];
  headerOffsetClassName?: string;
  onOpenSettings: () => void;
  onPullLatestChanges: () => void;
  pullingLatestChanges: boolean;
  onNavigate: (route: ShellRoute) => void;
}) {
  const workspaceSshEnabled = workspace.serverSettings.agent.transport === "ssh";
  const githubUrl = useWorkspaceGitHubUrl(workspace);
  const serverLabel = getWorkspaceHeaderServerLabel(workspace, registeredSshServers);
  const activityLoops = relatedLoops.filter((loop) => !isWorkspaceHistoryLoop(loop.state.status));
  const historyLoops = relatedLoops.filter((loop) => isWorkspaceHistoryLoop(loop.state.status));
  const activityDescription = workspaceSshEnabled
    ? "Active loops, chats, and SSH sessions in this workspace."
    : "Active loops and chats in this workspace. Legacy SSH sessions may also appear here for non-SSH workspaces.";
  const hasActivity = activityLoops.length > 0 || relatedChats.length > 0 || relatedSessions.length > 0;
  const activityRowClassName = "flex min-w-0 w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800";
  const historyDescription = "Merged and deleted loops from this workspace.";
  const createActionItems = buildWorkspaceActionItems({
    workspace,
    githubUrl,
    pullingLatestChanges,
    onNavigate,
    onPullLatestChanges,
    onOpenGitHub: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  });

  function renderLoopRow(loop: ReturnType<typeof useLoops>["loops"][number]) {
    const route: ShellRoute = { view: "loop", loopId: loop.config.id };
    const statusPill = getLoopStatusPill(loop);
    return (
      <button
        key={loop.config.id}
        type="button"
        onClick={() => onNavigate(route)}
        className={activityRowClassName}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {loop.config.name}
          </span>
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            Loop
          </span>
        </span>
        <StatusBadge className="ml-auto shrink-0" variant={statusPill.variant}>
          {statusPill.label}
        </StatusBadge>
      </button>
    );
  }

  return (
    <ShellPanel
      eyebrow="Workspace"
      title={workspace.name}
      description={serverLabel}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
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
          <ActionMenu items={createActionItems} ariaLabel={`Workspace actions for ${workspace.name}`} />
        </>
      )}
    >
      <div className="min-w-0 space-y-6">
        <div
          data-testid="workspace-activity-card"
          className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Activity</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">{activityDescription}</p>
          </div>
          {hasActivity ? (
            <div className="space-y-2">
              {activityLoops.map((loop) => renderLoopRow(loop))}
              {relatedChats.map((chat: Chat) => (
                <button
                  key={chat.config.id}
                  type="button"
                  onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
                  className={activityRowClassName}
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
              ))}
              {relatedSessions.map((session) => (
                <button
                  key={session.config.id}
                  type="button"
                  onClick={() => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                  className={activityRowClassName}
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
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">No active items in this workspace right now.</p>
          )}
        </div>

        {historyLoops.length > 0 ? (
          <div
            data-testid="workspace-history-card"
            className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">History</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">{historyDescription}</p>
            </div>
            <div className="space-y-2">
              {historyLoops.map((loop) => renderLoopRow(loop))}
            </div>
          </div>
        ) : null}
      </div>
    </ShellPanel>
  );
}
