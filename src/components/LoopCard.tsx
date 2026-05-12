/**
 * LoopCard component for displaying a loop summary in the dashboard grid.
 */

import type { LoopSummaryProps } from "../types";
import { Badge, Card, StatusBadge } from "./common";
import {
  getLoopStatusPill,
  isLoopPlanReady,
  isLoopActive,
  formatRelativeTime,
} from "../utils";

export function LoopCard({
  loop,
  onClick,
}: LoopSummaryProps) {
  const { config, state } = loop;
  const isActive = isLoopActive(state.status);
  const isPlanning = state.status === "planning";
  const isPlanReady = isLoopPlanReady(loop);
  const isDraft = state.status === "draft";
  const isAddressable = state.reviewMode?.addressable === true;
  const statusPill = getLoopStatusPill(loop);

  // Card ring color: amber for plan-ready, cyan for planning-in-progress
  const planningRingClass = isPlanReady
    ? "ring-2 ring-amber-500"
    : "ring-2 ring-cyan-500";

  return (
    <Card
      clickable={!!onClick}
      onClick={onClick}
      className={`relative flex h-full flex-col ${isActive ? "ring-2 ring-blue-500" : ""} ${isPlanning ? planningRingClass : ""}`}
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      {/* Status indicator */}
      {isActive && !isPlanning && (
        <div className="absolute -top-1 -right-1">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
          </span>
        </div>
      )}
      {/* Planning: pulsing cyan dot when AI is generating, static amber dot when plan is ready */}
      {isPlanning && !isPlanReady && (
        <div className="absolute -top-1 -right-1">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500" />
          </span>
        </div>
      )}
      {isPlanReady && (
        <div className="absolute -top-1 -right-1">
          <span className="relative flex h-3 w-3">
            <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-3">
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-1">
            <h3 className="min-w-0 flex-1 break-words text-base font-semibold text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere] sm:text-lg">
              {config.name}
            </h3>
          </div>
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            <StatusBadge variant={statusPill.variant}>
              {statusPill.label}
            </StatusBadge>
            {isAddressable && (
              <Badge variant="info">
                Addressable
              </Badge>
            )}
          </div>
        </div>
        {state.reviewMode && state.reviewMode.reviewCycles > 0 && (
          <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
            Review Cycle: {state.reviewMode.reviewCycles}
          </p>
        )}
      </div>

      {/* Error display - show when loop has an error */}
      {state.error && (
        <div className="mb-3 sm:mb-4 p-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-xs sm:text-sm text-red-800 dark:text-red-300 break-words">
            {state.error.message}
          </p>
        </div>
      )}

      {/* Git info - hide for drafts (no branch yet) */}
      {!isDraft && state.git && (
        <div className="mb-3 sm:mb-4 text-xs sm:text-sm">
          <span className="text-gray-500 dark:text-gray-400">Branch:</span>
          <span className="ml-2 break-words font-mono text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
            {state.git.workingBranch}
          </span>
          {state.git.commits.length > 0 && (
            <span className="ml-2 text-gray-500 dark:text-gray-400">
              ({state.git.commits.length} commits)
            </span>
          )}
        </div>
      )}

      {/* Stats */}
      {!isDraft && (
        <div className="mt-auto grid grid-cols-2 gap-2 sm:gap-4 text-xs sm:text-sm">
          <div className="min-w-0">
            <span className="text-gray-500 dark:text-gray-400 block sm:inline">Iterations:</span>
            <span className="ml-0 sm:ml-2 font-medium text-gray-900 dark:text-gray-100 block sm:inline">
              {state.currentIteration}
              {config.maxIterations ? `/${config.maxIterations}` : ""}
            </span>
          </div>
          <div className="min-w-0">
            <span className="text-gray-500 dark:text-gray-400 block sm:inline">Last activity:</span>
            <span className="ml-0 sm:ml-2 font-medium text-gray-900 dark:text-gray-100 block sm:inline">
              {formatRelativeTime(state.lastActivityAt)}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

export default LoopCard;
