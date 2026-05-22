/**
 * Dashboard header component with title, settings, and action buttons.
 */

import { useMemo } from "react";
import type { DashboardViewMode } from "../types/preferences";
import { ActionMenu, Button, GearIcon, GridIcon, ListIcon } from "./common";
import type { ActionMenuItem } from "./common";

export interface DashboardHeaderProps {
  version: string | null;
  viewMode: DashboardViewMode;
  onToggleViewMode: () => void;
  onOpenServerSettings: () => void;
  onOpenCreateWorkspace: () => void;
  onOpenCreateTask: () => void;
  onCreateSshSession: () => void;
}

export function DashboardHeader({
  version,
  viewMode,
  onToggleViewMode,
  onOpenServerSettings,
  onOpenCreateWorkspace,
  onOpenCreateTask,
  onCreateSshSession,
}: DashboardHeaderProps) {
  // Memoize action menu items to avoid re-creating on every render
  const actionMenuItems: ActionMenuItem[] = useMemo(
        () => [
          { label: "New Workspace", onClick: onOpenCreateWorkspace },
          { label: "New SSH Session", onClick: onCreateSshSession },
          { label: "New Task", onClick: onOpenCreateTask },
        ],
    [onOpenCreateWorkspace, onCreateSshSession, onOpenCreateTask],
  );

  return (
    <header className="bg-white dark:bg-neutral-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 safe-area-top">
      <div className="px-4 sm:px-6 lg:px-8 py-3 sm:py-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Left: Title + version */}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100">
              Clanky
            </h1>
            {version && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                v{version}
              </p>
            )}
          </div>

          {/* Right: All controls */}
          <div className="flex w-full flex-wrap items-center justify-end gap-2 lg:w-auto">
            {/* View mode toggle */}
            <div className="flex items-center rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden">
              <button
                type="button"
                onClick={viewMode === "rows" ? undefined : onToggleViewMode}
                className={`min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-1.5 sm:p-2 transition-colors ${
                  viewMode === "rows"
                    ? "bg-blue-100 text-blue-700 dark:bg-neutral-700/80 dark:text-blue-300"
                    : "bg-white text-gray-500 hover:bg-gray-100 dark:bg-neutral-800 dark:text-gray-400 dark:hover:bg-neutral-700"
                }`}
                title="Row view"
                aria-label="Switch to row view"
              >
                <ListIcon size="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={viewMode === "cards" ? undefined : onToggleViewMode}
                className={`min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center p-1.5 sm:p-2 transition-colors ${
                  viewMode === "cards"
                    ? "bg-blue-100 text-blue-700 dark:bg-neutral-700/80 dark:text-blue-300"
                    : "bg-white text-gray-500 hover:bg-gray-100 dark:bg-neutral-800 dark:text-gray-400 dark:hover:bg-neutral-700"
                }`}
                title="Card view"
                aria-label="Switch to card view"
              >
                <GridIcon size="h-4 w-4" />
              </button>
            </div>

            {/* Mobile: "+" action menu (visible below sm breakpoint) */}
            <div className="sm:hidden">
              <ActionMenu items={actionMenuItems} ariaLabel="Create new item" />
            </div>

            {/* Desktop: full action buttons (visible at sm+ breakpoint) */}
            <div className="hidden sm:flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                onClick={onOpenCreateWorkspace}
                className="whitespace-nowrap"
              >
                New Workspace
              </Button>
              <Button
                variant="secondary"
                onClick={onCreateSshSession}
                className="whitespace-nowrap"
              >
                New SSH Session
              </Button>
              <Button onClick={onOpenCreateTask} className="whitespace-nowrap">
                New Task
              </Button>
            </div>
            {/* App Settings Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenServerSettings}
              title="App Settings"
              aria-label="App Settings"
              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 px-1.5"
            >
              <GearIcon size="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
