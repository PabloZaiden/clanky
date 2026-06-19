import { memo, useMemo, type ReactNode } from "react";
import type { WorkspaceFileNode } from "../../types";
import { ActionMenu, Button, CopyPathIcon, RefreshIcon, SidebarIcon, type ActionMenuItem } from "../common";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
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
    <svg className="h-4 w-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="h-4 w-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
    </svg>
  );
}

interface FileTreeHeaderButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  ariaExpanded?: boolean;
}

function FileTreeHeaderButton({
  label,
  onClick,
  disabled,
  icon,
  ariaExpanded,
}: FileTreeHeaderButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onClick}
      disabled={disabled}
      icon={icon}
      aria-label={label}
      aria-expanded={ariaExpanded}
      title={label}
      className="w-8 px-0"
    >
      <span className="sr-only">{label}</span>
    </Button>
  );
}

interface WorkspaceFileTreeProps {
  entriesByDirectory: Record<string, WorkspaceFileNode[]>;
  expandedDirectories: string[];
  currentFilePath?: string;
  selectedNodePath?: string;
  showHiddenFiles: boolean;
  loading: boolean;
  error?: string | null;
  collapsed: boolean;
  onOpenRootPicker: () => void;
  onRefresh: () => Promise<void>;
  onToggleShowHiddenFiles: () => Promise<void>;
  onCopySelectedFilePath: () => Promise<void>;
  onDownloadSelectedFile: () => Promise<void>;
  onUploadFile: () => void;
  onRenameSelectedNode: () => void;
  onDeleteSelectedNode: () => void;
  onToggleCollapsed: () => void;
  onToggleDirectory: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
  canCopySelectedFilePath: boolean;
  canDownloadSelectedFile: boolean;
  canUploadFile: boolean;
  canRenameSelectedNode: boolean;
  canDeleteSelectedNode: boolean;
}

function isHiddenEntry(entry: WorkspaceFileNode): boolean {
  return entry.name.startsWith(".");
}

function renderDirectory(
  path: string,
  entriesByDirectory: Record<string, WorkspaceFileNode[]>,
  expandedDirectories: string[],
  currentFilePath: string | undefined,
  selectedNodePath: string | undefined,
  showHiddenFiles: boolean,
  onToggleDirectory: (path: string) => Promise<void>,
  onOpenFile: (path: string) => Promise<void>,
  depth = 0,
): ReactNode {
  const entries = (entriesByDirectory[path] ?? []).filter((entry) => showHiddenFiles || !isHiddenEntry(entry));
  return entries.map((entry) => {
    const isDirectory = entry.kind === "directory";
    const isExpanded = expandedDirectories.includes(entry.path);
    const isSelected = selectedNodePath === entry.path || (!selectedNodePath && currentFilePath === entry.path);

    return (
      <div key={entry.path}>
        <div className="min-w-full w-max">
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
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition whitespace-nowrap",
              isSelected
                ? "bg-gray-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-800",
            ].join(" ")}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            {isDirectory ? <Chevron expanded={isExpanded} /> : <span className="w-4 shrink-0" />}
            {isDirectory ? <FolderIcon /> : <FileIcon />}
            <span>{entry.name}</span>
          </button>
        </div>
        {isDirectory && isExpanded && renderDirectory(
          entry.path,
          entriesByDirectory,
          expandedDirectories,
          currentFilePath,
          selectedNodePath,
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
  selectedNodePath,
  showHiddenFiles,
  loading,
  error,
  collapsed,
  onOpenRootPicker,
  onRefresh,
  onToggleShowHiddenFiles,
  onCopySelectedFilePath,
  onDownloadSelectedFile,
  onUploadFile,
  onRenameSelectedNode,
  onDeleteSelectedNode,
  onToggleCollapsed,
  onToggleDirectory,
  onOpenFile,
  canCopySelectedFilePath,
  canDownloadSelectedFile,
  canUploadFile,
  canRenameSelectedNode,
  canDeleteSelectedNode,
}: WorkspaceFileTreeProps) {
  const collapseLabel = collapsed ? "Expand file explorer" : "Collapse file explorer";
  const actionItems = useMemo<ActionMenuItem[]>(() => [
    {
      id: "root",
      label: "Change explorer root",
      onClick: onOpenRootPicker,
    },
    {
      id: "hidden",
      label: showHiddenFiles ? "Hide hidden files" : "Show hidden files",
      disabled: loading,
      onClick: () => void onToggleShowHiddenFiles(),
    },
    {
      id: "download",
      label: "Download selected file",
      disabled: !canDownloadSelectedFile,
      onClick: () => void onDownloadSelectedFile(),
    },
    {
      id: "upload",
      label: "Upload file",
      disabled: !canUploadFile,
      onClick: onUploadFile,
    },
    {
      id: "rename",
      label: "Rename selected item",
      disabled: !canRenameSelectedNode,
      onClick: onRenameSelectedNode,
    },
    {
      id: "delete",
      label: "Delete selected item",
      disabled: !canDeleteSelectedNode,
      destructive: true,
      onClick: onDeleteSelectedNode,
    },
  ], [
    canDeleteSelectedNode,
    canDownloadSelectedFile,
    canRenameSelectedNode,
    canUploadFile,
    loading,
    onDeleteSelectedNode,
    onDownloadSelectedFile,
    onOpenRootPicker,
    onRenameSelectedNode,
    onToggleShowHiddenFiles,
    onUploadFile,
    showHiddenFiles,
  ]);
  const renderedTree = useMemo(() => renderDirectory(
    "",
    entriesByDirectory,
    expandedDirectories,
    currentFilePath,
    selectedNodePath,
    showHiddenFiles,
    onToggleDirectory,
    onOpenFile,
  ), [
    currentFilePath,
    entriesByDirectory,
    expandedDirectories,
    onOpenFile,
    onToggleDirectory,
    selectedNodePath,
    showHiddenFiles,
  ]);
  const collapseButton = (
    <FileTreeHeaderButton
      label={collapseLabel}
      onClick={onToggleCollapsed}
      icon={<SidebarIcon size="h-4 w-4" />}
      ariaExpanded={!collapsed}
    />
  );
  const refreshButton = (
    <FileTreeHeaderButton
      label="Refresh explorer"
      onClick={() => void onRefresh()}
      disabled={loading}
      icon={<RefreshIcon size="h-4 w-4" />}
    />
  );
  const copyPathButton = (
    <FileTreeHeaderButton
      label="Copy selected file path"
      onClick={() => void onCopySelectedFilePath()}
      disabled={!canCopySelectedFilePath}
      icon={<CopyPathIcon size="h-4 w-4" />}
    />
  );
  const actionsMenu = (
    <ActionMenu
      items={actionItems}
      ariaLabel="File explorer actions"
      triggerVariant="ghost"
      triggerSize="compact"
    />
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div
        data-testid="workspace-file-tree-header"
        className={[
          "border-b border-gray-200 dark:border-gray-800",
          collapsed
            ? "flex items-center justify-between gap-2 px-3 py-2 lg:h-full lg:flex-col lg:items-center lg:gap-2 lg:px-2 lg:py-3"
            : "flex flex-col items-stretch gap-2 px-3 py-2",
        ].join(" ")}
      >
        {collapsed && (
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400 lg:hidden">
            Files
          </div>
        )}
        {collapsed ? (
          <div className="flex items-center gap-1.5 lg:flex-col">
            {collapseButton}
            {refreshButton}
            {copyPathButton}
            {actionsMenu}
          </div>
        ) : (
          <div className="flex w-full items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              {refreshButton}
              {copyPathButton}
              {actionsMenu}
            </div>
            {collapseButton}
          </div>
        )}
        {collapsed && (
          <div className="mt-auto hidden text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400 lg:block [writing-mode:vertical-rl]">
            Files
          </div>
        )}
      </div>
      {!collapsed && (
        <div
          data-testid="workspace-file-tree-scroll"
          className="min-h-0 flex-1 overflow-auto p-2"
        >
          {error && (
            <div
              role="alert"
              className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {error}
            </div>
          )}
          <div data-testid="workspace-file-tree-content" className="min-w-full w-max">
            {renderedTree}
          </div>
        </div>
      )}
    </section>
  );
}

export const WorkspaceFileTree = memo(WorkspaceFileTreeComponent);
