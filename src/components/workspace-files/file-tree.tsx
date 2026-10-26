import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { ActionMenu, ContextMenu, type ActionMenuItem, type ContextMenuPosition } from "@pablozaiden/webapp/web";
import type { WorkspaceFileNode } from "@/shared";
import { Button, CopyPathIcon, RefreshIcon, SidebarIcon } from "../common";
import { WorkspaceFileTreeNodes } from "./file-tree-nodes";
import { useFileTreeDrop } from "./use-file-tree-drop";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";

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
      size="sm"
      onClick={onClick}
      disabled={disabled}
      icon={icon}
      aria-label={label}
      aria-expanded={ariaExpanded}
      title={label}
      className="w-9 px-0"
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
  dropError: string | null;
  collapsed: boolean;
  onOpenRootPicker: () => void;
  onRefresh: () => Promise<void>;
  onToggleShowHiddenFiles: () => Promise<void>;
  onCopySelectedFilePath: () => Promise<void>;
  onDownloadSelectedFile: () => Promise<void>;
  onUploadFile: () => void;
  onDropFiles: (files: readonly File[], targetDirectory: string) => void;
  onRenameSelectedNode: () => void;
  onDeleteSelectedNode: () => void;
  onDownloadNode: (node: WorkspaceFileNode) => Promise<void>;
  onRenameNode: (node: WorkspaceFileNode) => void;
  onDeleteNode: (node: WorkspaceFileNode) => void;
  nodeActionsDisabled: boolean;
  onToggleCollapsed: () => void;
  onToggleDirectory: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
  canCopySelectedFilePath: boolean;
  canDownloadSelectedFile: boolean;
  canUploadFile: boolean;
  canRenameSelectedNode: boolean;
  canDeleteSelectedNode: boolean;
}

function WorkspaceFileTreeComponent({
  entriesByDirectory,
  expandedDirectories,
  currentFilePath,
  selectedNodePath,
  showHiddenFiles,
  loading,
  error,
  dropError,
  collapsed,
  onOpenRootPicker,
  onRefresh,
  onToggleShowHiddenFiles,
  onCopySelectedFilePath,
  onDownloadSelectedFile,
  onUploadFile,
  onDropFiles,
  onRenameSelectedNode,
  onDeleteSelectedNode,
  onDownloadNode,
  onRenameNode,
  onDeleteNode,
  nodeActionsDisabled,
  onToggleCollapsed,
  onToggleDirectory,
  onOpenFile,
  canCopySelectedFilePath,
  canDownloadSelectedFile,
  canUploadFile,
  canRenameSelectedNode,
  canDeleteSelectedNode,
}: WorkspaceFileTreeProps) {
  const readOnly = useWorkspaceReadOnly();
  const {
    dropTargetDirectory,
    dropZoneRef,
    handleDirectoryDragEnter,
    handleDirectoryDragLeave,
    handleDirectoryDragOver,
    handleDirectoryDrop,
    handleTreeDragEnter,
    handleTreeDragLeave,
    handleTreeDragOver,
    handleTreeDrop,
  } = useFileTreeDrop({ canUploadFile, onDropFiles });
  const [contextMenu, setContextMenu] = useState<{
    node: WorkspaceFileNode;
    position: ContextMenuPosition;
  } | null>(null);
  const openContextMenu = useCallback((node: WorkspaceFileNode, position: ContextMenuPosition) => {
    setContextMenu({ node, position });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const visibleErrors = [error, dropError].filter(
    (message): message is string => typeof message === "string" && message.length > 0,
  );
  const getNodeActions = useCallback((node: WorkspaceFileNode): ActionMenuItem[] => [
    ...(node.kind === "file" ? [{
      id: "download",
      label: "Download",
      disabled: nodeActionsDisabled,
      onAction: () => void onDownloadNode(node),
    }] : []),
    ...(!readOnly ? [{
      id: "rename",
      label: "Rename",
      disabled: nodeActionsDisabled,
      onAction: () => onRenameNode(node),
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      disabled: nodeActionsDisabled,
      onAction: () => onDeleteNode(node),
    }] : []),
  ], [nodeActionsDisabled, onDeleteNode, onDownloadNode, onRenameNode, readOnly]);
  const collapseLabel = collapsed ? "Expand file explorer" : "Collapse file explorer";
  const actionItems = useMemo<ActionMenuItem[]>(() => [
    {
      id: "root",
      label: "Change explorer root",
      onAction: onOpenRootPicker,
    },
    {
      id: "hidden",
      label: showHiddenFiles ? "Hide hidden files" : "Show hidden files",
      disabled: loading,
      onAction: () => void onToggleShowHiddenFiles(),
    },
    {
      id: "download",
      label: "Download selected file",
      disabled: !canDownloadSelectedFile,
      onAction: () => void onDownloadSelectedFile(),
    },
    {
      id: "upload",
      label: "Upload file",
      disabled: !canUploadFile,
      onAction: onUploadFile,
    },
    {
      id: "rename",
      label: "Rename selected item",
      disabled: !canRenameSelectedNode,
      onAction: onRenameSelectedNode,
    },
    {
      id: "delete",
      label: "Delete selected item",
      disabled: !canDeleteSelectedNode,
      destructive: true,
      onAction: onDeleteSelectedNode,
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
    <section className={`flex h-full min-h-0 min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900 ${collapsed ? "flex-col" : "flex-row lg:flex-col"}`}>
      <div
        data-testid="workspace-file-tree-header"
        className={[
          "shrink-0 border-gray-200 dark:border-gray-800",
          collapsed
            ? "flex items-center justify-between gap-2 px-3 py-2 lg:h-full lg:flex-col lg:items-center lg:gap-2 lg:px-2 lg:py-3"
            : "flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto border-r px-1 py-2 lg:flex-row lg:justify-between lg:border-r-0 lg:border-b lg:px-3",
        ].join(" ")}
      >
        {collapsed ? (
          <div className="flex items-center gap-1.5 lg:flex-col">
            {collapseButton}
            {refreshButton}
            {copyPathButton}
            {actionsMenu}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center gap-1.5 lg:flex-row">
              {collapseButton}
              {copyPathButton}
              {refreshButton}
            </div>
            {actionsMenu}
          </>
        )}
        {collapsed && (
          <div className="mt-auto hidden text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400 lg:block [writing-mode:vertical-rl]">
            Files
          </div>
        )}
      </div>
      {!collapsed && (
        <div
          ref={dropZoneRef}
          data-testid="workspace-file-tree-scroll"
          aria-busy={loading}
          onDragEnter={handleTreeDragEnter}
          onDragOver={handleTreeDragOver}
          onDragLeave={handleTreeDragLeave}
          onDrop={handleTreeDrop}
          className={[
            "relative min-h-0 flex-1 overflow-auto p-2",
            loading ? "min-h-32" : "",
            dropTargetDirectory === ""
              ? "ring-2 ring-inset ring-blue-500 bg-blue-50/50 dark:bg-blue-950/30"
              : "",
          ].join(" ")}
        >
          {visibleErrors.map((message, index) => (
            <div
              key={`${index}-${message}`}
              role="alert"
              className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {message}
            </div>
          ))}
          <div data-testid="workspace-file-tree-content" className="min-w-max w-full">
            <WorkspaceFileTreeNodes
              path=""
              entriesByDirectory={entriesByDirectory}
              expandedDirectories={expandedDirectories}
              currentFilePath={currentFilePath}
              selectedNodePath={selectedNodePath}
              showHiddenFiles={showHiddenFiles}
              dropTargetDirectory={dropTargetDirectory}
              onDirectoryDragEnter={handleDirectoryDragEnter}
              onDirectoryDragOver={handleDirectoryDragOver}
              onDirectoryDragLeave={handleDirectoryDragLeave}
              onDirectoryDrop={handleDirectoryDrop}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
              onContextMenu={openContextMenu}
            />
          </div>
          {loading && (
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/80 px-4 text-center text-sm text-gray-500 backdrop-blur-[1px] dark:bg-neutral-900/80 dark:text-gray-400"
            >
              <div
                aria-hidden="true"
                className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent dark:border-gray-500"
              />
              <div>
                <p className="font-medium text-gray-700 dark:text-gray-200">Loading file tree...</p>
                <p className="mt-1">Fetching files</p>
              </div>
            </div>
          )}
        </div>
      )}
      <ContextMenu
        items={contextMenu ? getNodeActions(contextMenu.node) : []}
        position={contextMenu?.position ?? null}
        ariaLabel={contextMenu ? `Actions for ${contextMenu.node.name}` : "File actions"}
        onClose={closeContextMenu}
      />
    </section>
  );
}

export const WorkspaceFileTree = memo(WorkspaceFileTreeComponent);
