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

interface WorkspaceFileTreeProps {
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>;
  expandedDirectories: string[];
  currentFilePath?: string;
  loading: boolean;
  collapsed: boolean;
  onRefresh: () => Promise<void>;
  onToggleCollapsed: () => void;
  onToggleDirectory: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
}

function renderDirectory(
  path: string,
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>,
  expandedDirectories: string[],
  currentFilePath: string | undefined,
  onToggleDirectory: (path: string) => Promise<void>,
  onOpenFile: (path: string) => Promise<void>,
  depth = 0,
): React.ReactNode {
  const entries = entriesByDirectory[path] ?? [];
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
          onToggleDirectory,
          onOpenFile,
          depth + 1,
        )}
      </div>
    );
  });
}

export function WorkspaceFileTree({
  entriesByDirectory,
  expandedDirectories,
  currentFilePath,
  loading,
  collapsed,
  onRefresh,
  onToggleCollapsed,
  onToggleDirectory,
  onOpenFile,
}: WorkspaceFileTreeProps) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div
        className={[
          "border-b border-gray-200 dark:border-gray-800",
          collapsed ? "flex h-full flex-col items-center gap-2 px-2 py-3" : "flex items-center justify-between px-3 py-2",
        ].join(" ")}
      >
        {!collapsed && (
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Explorer</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">Workspace files</p>
          </div>
        )}
        <div className={collapsed ? "flex flex-col gap-2" : "flex items-center gap-2"}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onRefresh()}
            loading={loading}
            icon={<RefreshIcon size="h-4 w-4" />}
            aria-label="Refresh explorer"
            title="Refresh explorer"
            className={collapsed ? "w-9 px-0" : ""}
          >
            {collapsed ? <span className="sr-only">Refresh</span> : "Refresh"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand file explorer" : "Collapse file explorer"}
            title={collapsed ? "Expand file explorer" : "Collapse file explorer"}
            className={collapsed ? "w-9 px-0" : ""}
          >
            {collapsed ? <span aria-hidden="true">»</span> : "Collapse"}
          </Button>
        </div>
        {collapsed && (
          <div className="mt-auto text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400 [writing-mode:vertical-rl]">
            Files
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {renderDirectory("", entriesByDirectory, expandedDirectories, currentFilePath, onToggleDirectory, onOpenFile)}
        </div>
      )}
    </section>
  );
}
