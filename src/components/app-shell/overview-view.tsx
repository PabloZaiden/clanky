import { useMemo } from "react";
import type { SshServer, SshServerSession } from "../../types";
import type { useLoopGrouping, useLoops } from "../../hooks";
import { getLoopStatusLabel, shouldShowInRecentActivity } from "../../utils";
import { Badge, getStatusBadgeVariant, StatusBadge } from "../common";
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";
import { EmptySection } from "./shell-sidebar";

export function OverviewView({
  loops,
  servers,
  sessionsByServerId,
  workspaceGroups,
  headerOffsetClassName,
  onNavigate,
}: {
  loops: ReturnType<typeof useLoops>["loops"];
  servers: SshServer[];
  sessionsByServerId: Record<string, SshServerSession[]>;
  workspaceGroups: ReturnType<typeof useLoopGrouping>["workspaceGroups"];
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
}) {
  const recentLoops = useMemo(() => {
    return loops
      .filter((loop) => shouldShowInRecentActivity(loop.state.status))
      .sort((left, right) => right.config.createdAt.localeCompare(left.config.createdAt))
      .slice(0, 5);
  }, [loops]);
  const serverMapItems = useMemo(() => {
    return servers.map((server) => ({
      server,
      sessionCount: sessionsByServerId[server.config.id]?.length ?? 0,
    }));
  }, [servers, sessionsByServerId]);

  return (
    <ShellPanel
      eyebrow="Overview"
      title="Ralpher"
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
    >
      <div className="space-y-6">
        <div
          data-testid="recent-activity-card"
          className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
        >
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Recent activity</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Jump back into active loops or chats from the overview.
            </p>
          </div>
          <div className="space-y-2">
            {recentLoops.length === 0 ? (
              <EmptySection message="Recent activity will appear here as you start work." />
            ) : (
              recentLoops.map((loop) => {
                const route: ShellRoute = loop.config.mode === "chat"
                  ? { view: "chat", chatId: loop.config.id }
                  : { view: "loop", loopId: loop.config.id };
                const label = getLoopStatusLabel(loop);
                return (
                  <button
                    key={loop.config.id}
                    type="button"
                    onClick={() => onNavigate(route)}
                    className="flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                        {loop.config.name}
                      </span>
                      <span className="mt-1 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                        {loop.config.directory}
                      </span>
                    </span>
                    <StatusBadge variant={getStatusBadgeVariant(loop.state.status)} className="shrink-0">
                      {label}
                    </StatusBadge>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Server maps</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Jump into saved SSH servers to review standalone sessions and start new terminals.
            </p>
          </div>
          <div className="space-y-2">
            {serverMapItems.length === 0 ? (
              <EmptySection message="No SSH servers yet. Register one to see it here." />
            ) : (
              serverMapItems.map(({ server, sessionCount }) => (
                <button
                  key={server.config.id}
                  type="button"
                  onClick={() => onNavigate({ view: "ssh-server", serverId: server.config.id })}
                  className="flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="block break-words text-sm font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                      {server.config.name}
                    </span>
                    <span className="mt-1 block break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                      {server.config.username}@{server.config.address}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-right text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
                    {sessionCount} session{sessionCount === 1 ? "" : "s"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50">
          <div>
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Workspaces map</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Browse workspaces first, then branch into loops, chats, and terminals from there.
            </p>
          </div>
          <div className="space-y-2">
            {workspaceGroups.length === 0 ? (
              <EmptySection message="No workspaces yet. Start by creating one." />
            ) : (
              workspaceGroups.map((group) => (
                <button
                  key={group.workspace.id}
                  type="button"
                  onClick={() => onNavigate({ view: "workspace", workspaceId: group.workspace.id })}
                  className="flex w-full items-center justify-between rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {group.workspace.name}
                    </span>
                    <span className="mt-1 block truncate text-xs text-gray-500 dark:text-gray-400">
                      {group.workspace.directory}
                    </span>
                  </span>
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
                    {group.loops.length} items
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </ShellPanel>
  );
}
