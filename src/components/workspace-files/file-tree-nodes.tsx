import { memo } from "react";
import { ActionMenu, type ActionMenuItem, type ContextMenuPosition } from "@pablozaiden/webapp/web";
import type { WorkspaceFileNode } from "@/shared";

interface WorkspaceFileTreeNodesProps {
  path: string;
  depth?: number;
  entriesByDirectory: Record<string, WorkspaceFileNode[]>;
  expandedDirectories: string[];
  currentFilePath?: string;
  selectedNodePath?: string;
  showHiddenFiles: boolean;
  onToggleDirectory: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
  getNodeActions: (node: WorkspaceFileNode) => ActionMenuItem[];
  onContextMenu: (node: WorkspaceFileNode, position: ContextMenuPosition) => void;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function EntryIcon({ directory }: { directory: boolean }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${directory ? "text-amber-500" : "text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d={directory
        ? "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        : "M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"} />
    </svg>
  );
}

function WorkspaceFileTreeNodesComponent(props: WorkspaceFileTreeNodesProps) {
  const {
    path,
    depth = 0,
    entriesByDirectory,
    expandedDirectories,
    currentFilePath,
    selectedNodePath,
    showHiddenFiles,
    onToggleDirectory,
    onOpenFile,
    getNodeActions,
    onContextMenu,
  } = props;
  const entries = (entriesByDirectory[path] ?? []).filter((entry) => showHiddenFiles || !entry.name.startsWith("."));

  return entries.map((entry) => {
    const isDirectory = entry.kind === "directory";
    const isExpanded = expandedDirectories.includes(entry.path);
    const isSelected = selectedNodePath === entry.path || (!selectedNodePath && currentFilePath === entry.path);

    return (
      <div key={entry.path}>
        <div
          className={[
            "flex min-w-full items-center rounded-lg transition",
            isSelected
              ? "bg-gray-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-800",
          ].join(" ")}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu(entry, { x: event.clientX, y: event.clientY });
          }}
        >
          <button
            type="button"
            onClick={() => {
              if (isDirectory) {
                void onToggleDirectory(entry.path);
              } else {
                void onOpenFile(entry.path);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                onContextMenu(entry, { x: bounds.left, y: bounds.bottom });
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm whitespace-nowrap"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            {isDirectory ? <Chevron expanded={isExpanded} /> : <span className="w-4 shrink-0" />}
            <EntryIcon directory={isDirectory} />
            <span>{entry.name}</span>
          </button>
          <ActionMenu
            items={getNodeActions(entry)}
            ariaLabel={`Actions for ${entry.name}`}
            triggerVariant="ghost"
            triggerSize="compact"
          />
        </div>
        {isDirectory && isExpanded && (
          <WorkspaceFileTreeNodes {...props} path={entry.path} depth={depth + 1} />
        )}
      </div>
    );
  });
}

export const WorkspaceFileTreeNodes = memo(WorkspaceFileTreeNodesComponent);
