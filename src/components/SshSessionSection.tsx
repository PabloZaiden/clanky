/**
 * Dashboard section for SSH sessions.
 */

import type { SshSession, Workspace } from "../types";
import { getEffectiveSshConnectionMode, getSshConnectionModeLabel, isPersistentSshSession } from "../utils";
import { Badge, Card, EditIcon, getSshSessionStatusBadgeVariant, getSshSessionStatusLabel, StatusBadge } from "./common";

export interface SshSessionSectionProps {
  sessions: SshSession[];
  workspaces: Workspace[];
  workspacesLoaded: boolean;
  loading: boolean;
  error: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
}

export function SshSessionSection({
  sessions,
  workspaces,
  workspacesLoaded,
  loading,
  error,
  onSelect,
  onRename,
}: SshSessionSectionProps) {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));

  return (
    <Card>
      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading SSH sessions...</p>
      ) : error ? (
        <p className="break-words text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No SSH sessions yet. Create one to start a saved remote terminal.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sessions.map((session) => {
            const effectiveConnectionMode = getEffectiveSshConnectionMode(session);
            const workspaceMissing =
              workspacesLoaded &&
              !!session.config.workspaceId &&
              !workspaceIds.has(session.config.workspaceId);
            return (
              <div
                key={session.config.id}
                className="relative rounded-lg border border-gray-200 bg-white transition-colors hover:border-gray-300 hover:shadow-sm dark:border-gray-700 dark:bg-neutral-800 dark:hover:border-gray-600"
              >
                <button
                  type="button"
                  onClick={() => onSelect(session.config.id)}
                  className="absolute inset-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                  aria-label={`Open SSH session ${session.config.name}`}
                />
                <div className="pointer-events-none relative z-10 p-4">
                  <div className="flex min-w-0 items-start gap-3 pr-8">
                    <div className="min-w-0 flex-1">
                      <h3 className="break-words font-medium text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
                        {session.config.name}
                      </h3>
                      {workspaceMissing && (
                        <div className="mt-1">
                          <Badge variant="warning" size="sm">Workspace missing</Badge>
                        </div>
                      )}
                      <p className="mt-1 break-words text-xs font-mono text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                        {session.config.directory}
                      </p>
                    </div>
                    <StatusBadge variant={getSshSessionStatusBadgeVariant(session.state.status)} className="shrink-0">
                      {getSshSessionStatusLabel(session.state.status)}
                    </StatusBadge>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(session.config.id);
                    }}
                    className="pointer-events-auto absolute right-4 top-4 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-700 dark:hover:text-gray-300"
                    aria-label="Rename SSH session"
                    title="Rename SSH session"
                  >
                    <EditIcon size="h-3.5 w-3.5" />
                  </button>
                  <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    Last connected: {session.state.lastConnectedAt ?? "Never"}
                  </p>
                  <p className="mt-1 break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                    Mode: {getSshConnectionModeLabel(effectiveConnectionMode)}
                  </p>
                  {workspaceMissing && (
                    <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-300 [overflow-wrap:anywhere]">
                      The saved workspace for this SSH session is no longer available, but the session can still be opened or deleted.
                    </p>
                  )}
                  {isPersistentSshSession(session) && (
                    <p className="mt-1 break-words text-xs text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]">
                      Persistent ID: {session.config.remoteSessionName}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
