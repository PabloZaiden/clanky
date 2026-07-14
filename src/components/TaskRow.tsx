/**
 * TaskRow component for displaying a task summary as a horizontal row.
 * Shows full task info without truncation, one row per task.
 */

import type { TaskSummaryProps } from "./task-summary-types";
import { Badge, StatusBadge } from "./common";
import {
  getTaskStatusPill,
  isTaskPlanReady,
  isTaskActive,
  formatRelativeTime,
} from "../utils";

export function TaskRow({
  task,
  onClick,
  privateHidden = false,
}: TaskSummaryProps) {
  const { config, state } = task;
  const isActive = isTaskActive(state.status);
  const isPlanning = state.status === "planning";
  const isPlanReady = isTaskPlanReady(task);
  const isDraft = state.status === "draft";
  const isAddressable = state.reviewMode?.addressable === true;
  const statusPill = getTaskStatusPill(task);

  // Row border highlight for active/planning states
  const borderClass = isActive && !isPlanning
    ? "border-l-4 border-l-blue-500"
    : isPlanning
      ? isPlanReady
        ? "border-l-4 border-l-amber-500"
        : "border-l-4 border-l-cyan-500"
      : "border-l-4 border-l-transparent";

  return (
    <div
      className={`relative rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-neutral-800 ${borderClass} ${
        onClick && !privateHidden ? "cursor-pointer hover:border-gray-300 hover:shadow-md dark:hover:border-gray-600" : ""
      } ${privateHidden ? "clanky-private-obscured" : ""
      }`}
      onClick={privateHidden ? undefined : onClick}
    >
      <div className="px-4 py-3">
        {/* Responsive layout: stack on small screens and wrap across rows on wider layouts as needed */}
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:gap-4">
          {/* Status indicator dot + name */}
          <div className="flex min-w-0 flex-1 items-start gap-2">
            {/* Status dot */}
            {isActive && !isPlanning && (
              <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
              </span>
            )}
            {isPlanning && !isPlanReady && (
              <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500" />
              </span>
            )}
            {isPlanReady && (
              <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
              </span>
            )}
            {!isActive && !isPlanning && (
              <span className="w-2.5 flex-shrink-0" />
            )}

            {/* Name - no truncation */}
            <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere] sm:text-base">
              {config.name}
            </h3>
          </div>

          {/* Badges */}
          <div className="flex max-w-full flex-wrap items-center gap-1.5">
            <StatusBadge variant={statusPill.variant}>
              {statusPill.label}
            </StatusBadge>
            {isAddressable && (
              <Badge variant="info">
                Addressable
              </Badge>
            )}
            {state.reviewMode && state.reviewMode.reviewCycles > 0 && (
              <span className="text-xs text-blue-600 dark:text-blue-400">
                RC:{state.reviewMode.reviewCycles}
              </span>
            )}
          </div>

          {/* Meta info - iterations, last activity */}
          {!isDraft && (
            <div className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              <span title="Iterations">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {state.currentIteration}
                  {config.maxIterations && config.maxIterations !== Infinity ? `/${config.maxIterations}` : ""}
                </span>
                {" iter"}
              </span>
              <span title="Last activity">
                {formatRelativeTime(state.lastActivityAt)}
              </span>
            </div>
          )}

        </div>

        {/* Error display */}
        {state.error && (
          <div className="mt-2 p-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <p className="text-xs text-red-800 dark:text-red-300 break-words">
              {state.error.message}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default TaskRow;
