import { memo, useMemo, type ReactNode } from "react";
import type { WorkspaceFileEntry } from "../../types";
import { Button, RefreshIcon } from "../common";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="h-4 w-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
    </svg>
  );
}

function ExplorerToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function HiddenFilesIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z"
      />
      <circle cx="12" cy="12" r="3" />
      {!visible && (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 4l16 16"
        />
      )}
    </svg>
  );
}

interface WorkspaceFileTreeProps {
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>;
  expandedDirectories: string[];
  currentFilePath?: string;
  showHiddenFiles: boolean;
  loading: boolean;
  error?: string | null;
  collapsed: boolean;
  toolbarActions?: ReactNode;
  onRefresh: () => Promise<void>;
  onToggleShowHiddenFiles: () => Promise<void>;
  onToggleCollapsed: () => void;
  onToggleDirectory: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
}

function isHiddenEntry(entry: WorkspaceFileEntry): boolean {
  return entry.name.startsWith(".");
}

function renderDirectory(
  path: string,
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>,
  expandedDirectories: string[],
  currentFilePath: string | undefined,
  showHiddenFiles: boolean,
  onToggleDirectory: (path: string) => Promise<void>,
  onOpenFile: (path: string) => Promise<void>,
  depth = 0,
): React.ReactNode {
  const entries = (entriesByDirectory[path] ?? []).filter((entry) => showHiddenFiles || !isHiddenEntry(entry));
  return entries.map((entry) => {
    const isDirectory = entry.kind === "directory";
    const isExpanded = expandedDirectories.includes(entry.path);
    const isSelected = currentFilePath === entry.path;

    return (
      <div key={entry.path}>
        <button
          type="button"
          onClick={() => {
            if (isDirectory) {
              void onToggleDirectory(entry.path);
              return;
            }
            void onOpenFile(entry.path);
          }}
          className={[
            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition",
            isSelected
              ? "bg-gray-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-800",
          ].join(" ")}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          {isDirectory ? <Chevron expanded={isExpanded} /> : <span className="w-4" />}
          {isDirectory ? <FolderIcon /> : <FileIcon />}
          <span className="truncate">{entry.name}</span>
        </button>
        {isDirectory && isExpanded && renderDirectory(
          entry.path,
          entriesByDirectory,
          expandedDirectories,
          currentFilePath,
          showHiddenFiles,
          onToggleDirectory,
          onOpenFile,
          depth + 1,
        )}
      </div>
    );
  });
}

function WorkspaceFileTreeComponent({
  entriesByDirectory,
  expandedDirectories,
  currentFilePath,
  showHiddenFiles,
  loading,
  error,
  collapsed,
  toolbarActions,
  onRefresh,
  onToggleShowHiddenFiles,
  onToggleCollapsed,
  onToggleDirectory,
  onOpenFile,
}: WorkspaceFileTreeProps) {
  const renderedTree = useMemo(() => renderDirectory(
    "",
    entriesByDirectory,
    expandedDirectories,
    currentFilePath,
    showHiddenFiles,
    onToggleDirectory,
    onOpenFile,
  ), [
    currentFilePath,
    entriesByDirectory,
    expandedDirectories,
    onOpenFile,
    onToggleDirectory,
    showHiddenFiles,
  ]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div
        data-testid="workspace-file-tree-header"
        className={[
          "border-b border-gray-200 dark:border-gray-800",
          collapsed
            ? "flex items-center justify-between gap-2 px-3 py-2 lg:h-full lg:flex-col lg:items-center lg:gap-2 lg:px-2 lg:py-3"
            : "flex items-center justify-between px-3 py-2",
        ].join(" ")}
      >
        {collapsed && (
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400 lg:hidden">
            Files
          </div>
        )}
        {!collapsed && (
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Explorer</h2>
          </div>
        )}
        <div className={collapsed ? "flex items-center gap-2 lg:flex-col" : "flex items-center gap-2"}>
          {toolbarActions}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onRefresh()}
            loading={loading}
            icon={<RefreshIcon size="h-4 w-4" />}
            aria-label="Refresh explorer"
            title="Refresh explorer"
            className="w-9 px-0"
          >
            <span className="sr-only">Refresh explorer</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onToggleShowHiddenFiles()}
            disabled={loading}
            aria-label={showHiddenFiles ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHiddenFiles}
            title={showHiddenFiles ? "Hide hidden files" : "Show hidden files"}
            className="w-9 px-0"
            icon={<HiddenFilesIcon visible={showHiddenFiles} />}
          >
            <span className="sr-only">{showHiddenFiles ? "Hide hidden files" : "Show hidden files"}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand file explorer" : "Collapse file explorer"}
            title={collapsed ? "Expand file explorer" : "Collapse file explorer"}
            className="w-9 px-0"
            icon={<ExplorerToggleIcon collapsed={collapsed} />}
          >
            <span className="sr-only">{collapsed ? "Expand file explorer" : "Collapse file explorer"}</span>
          </Button>
        </div>
        {collapsed && (
          <div className="mt-auto hidden text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400 lg:block [writing-mode:vertical-rl]">
            Files
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {error && (
            <div
              role="alert"
              className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {error}
            </div>
          )}
          {renderedTree}
        </div>
      )}
    </section>
  );
}

export const WorkspaceFileTree = memo(WorkspaceFileTreeComponent);
