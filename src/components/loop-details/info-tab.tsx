import type { Loop } from "../../types/loop";
import type { PortForward } from "../../types";
import type { EntityLabels } from "../../utils";
import { formatDateTime, formatModelDisplay } from "./types";
import { appAbsoluteUrl } from "../../lib/public-path";
import { Button, getPortForwardStatusBadgeVariant, getPortForwardStatusLabel, StatusBadge } from "../common";

interface InfoTabProps {
  loop: Loop;
  labels: EntityLabels;
  onOpenLoopFiles: () => void;
  sshConnecting: boolean;
  onConnectViaSsh: () => void;
  newForwardPort: string;
  onNewForwardPortChange: (v: string) => void;
  creatingForward: boolean;
  onCreateForward: () => void;
  forwards: PortForward[];
  forwardsLoading: boolean;
  forwardsError: string | null;
  onOpenForward: (id: string) => void;
  onCopyForwardUrl: (id: string) => void;
  onDeleteForward: (id: string) => void;
  loopId: string;
}

export function InfoTab({
  loop,
  labels,
  onOpenLoopFiles,
  sshConnecting,
  onConnectViaSsh,
  newForwardPort,
  onNewForwardPortChange,
  creatingForward,
  onCreateForward,
  forwards,
  forwardsLoading,
  forwardsError,
  onOpenForward,
  onCopyForwardUrl,
  onDeleteForward,
  loopId,
}: InfoTabProps) {
  const { config, state } = loop;

  return (
    <div className="flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto dark-scrollbar">
      <div className="min-w-0 w-full space-y-4 px-3 py-3 sm:px-4 sm:py-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{labels.capitalized} Information</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Statistics */}
          <div className="space-y-2">
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Iteration: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {state.currentIteration}{config.maxIterations ? ` / ${config.maxIterations}` : ""}
              </span>
            </div>
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Started: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{formatDateTime(state.startedAt)}</span>
            </div>
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Last Activity: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{formatDateTime(state.lastActivityAt)}</span>
            </div>
            {state.completedAt && (
              <div className="text-sm">
                <span className="text-gray-500 dark:text-gray-400">Completed: </span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{formatDateTime(state.completedAt)}</span>
              </div>
            )}
          </div>

          {/* Git and Model info */}
          <div className="space-y-2">
            {state.git && (
              <>
                <div className="text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Branch: </span>
                  <span className="font-mono font-medium text-gray-900 dark:text-gray-100 break-all">{state.git.originalBranch}</span>
                  <span className="text-gray-400 dark:text-gray-500"> → </span>
                  <span className="font-mono font-medium text-gray-900 dark:text-gray-100 break-all">{state.git.workingBranch}</span>
                </div>
                <div className="text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Commits: </span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{state.git.commits.length}</span>
                </div>
                {state.git.worktreePath && (
                  <div className="text-sm">
                    <span className="text-gray-500 dark:text-gray-400">Worktree: </span>
                    <span className="font-mono font-medium text-gray-900 dark:text-gray-100 break-all">{state.git.worktreePath}</span>
                  </div>
                )}
              </>
            )}
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Model: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {formatModelDisplay(config.model)}
              </span>
              {state.pendingModel && (
                <span className="ml-1 text-yellow-600 dark:text-yellow-400">
                  → {formatModelDisplay(state.pendingModel)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
          <button
            onClick={onOpenLoopFiles}
            className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
              <span className="text-gray-700 dark:text-gray-300 text-sm">{"</>"}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Open code explorer</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Browse this loop&apos;s files and open a loop-linked terminal
              </div>
            </div>
            <span className="text-gray-400 dark:text-gray-500">→</span>
          </button>

          <button
            onClick={onConnectViaSsh}
            disabled={sshConnecting}
            className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
              <span className="text-gray-700 dark:text-gray-300 text-sm">⌁</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {sshConnecting ? "Connecting..." : "Connect via ssh"}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Open or reconnect to this loop&apos;s persistent SSH session
              </div>
            </div>
            <span className="text-gray-400 dark:text-gray-500">→</span>
          </button>

          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Forward a Port</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Expose a remote service through a Ralpher URL in a new browser window.
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-gray-500 dark:text-gray-400">Remote port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={newForwardPort}
                  onChange={(e) => onNewForwardPortChange(e.target.value)}
                  className="w-28 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100"
                  inputMode="numeric"
                  placeholder=""
                />
              </label>
              <Button
                size="sm"
                onClick={onCreateForward}
                disabled={creatingForward}
              >
                {creatingForward ? "Creating..." : "Create Port Forward"}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 mb-3">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Port Forwards</h4>
            {forwardsLoading && (
              <span className="text-xs text-gray-500 dark:text-gray-400">Refreshing...</span>
            )}
          </div>
          {forwardsError && (
            <p className="mb-3 text-sm text-red-600 dark:text-red-400">{forwardsError}</p>
          )}
          {forwards.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No forwarded ports yet. Create one above.
            </p>
          ) : (
            <div className="space-y-3">
              {forwards.map((forward) => (
                <div
                  key={forward.config.id}
                  className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-neutral-900"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusBadge variant={getPortForwardStatusBadgeVariant(forward.state.status)}>
                          {getPortForwardStatusLabel(forward.state.status)}
                        </StatusBadge>
                        <span className="font-mono text-sm text-gray-900 dark:text-gray-100">
                          {forward.config.remoteHost}:{forward.config.remotePort}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
                        {appAbsoluteUrl(`/loop/${loopId}/port/${forward.config.id}/`)}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Local listener: {forward.config.localPort}
                      </div>
                      {forward.state.error && (
                        <div className="text-xs text-red-600 dark:text-red-400">
                          {forward.state.error}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => onOpenForward(forward.config.id)}
                        disabled={forward.state.status !== "active"}
                      >
                        Open
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onCopyForwardUrl(forward.config.id)}
                      >
                        Copy URL
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => onDeleteForward(forward.config.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
