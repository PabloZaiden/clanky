import { useEffect, useMemo, useState } from "react";
import type { CreateSshSessionRequest, SshSession, Workspace } from "../../types";
import { useWorkspaceFiles, useToast } from "../../hooks";
import { SshSessionDetails } from "../SshSessionDetails";
import { Button } from "../common";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import { WorkspaceFileTree } from "../workspace-files/file-tree";
import { WorkspaceEditorPanel } from "../workspace-files/editor-panel";
import { WorkspaceFileConflictModal } from "../workspace-files/conflict-modal";

interface WorkspaceFilesViewProps {
  workspace: Workspace;
  sessions: SshSession[];
  headerOffsetClassName?: string;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  onNavigate: (route: ShellRoute) => void;
}

function TerminalIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 7l5 5-5 5M13 17h6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
    </svg>
  );
}

type WorkspacePane = "editor" | "terminal";

export function WorkspaceFilesView({
  workspace,
  sessions,
  headerOffsetClassName,
  createSession,
  onNavigate,
}: WorkspaceFilesViewProps) {
  const toast = useToast();
  const workspaceFiles = useWorkspaceFiles(workspace.id);
  const [activePane, setActivePane] = useState<WorkspacePane>("editor");
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const workspaceSessions = useMemo(
    () => sessions.filter((session) => session.config.workspaceId === workspace.id),
    [sessions, workspace.id],
  );
  const hasSshTransport = workspace.serverSettings.agent.transport === "ssh";

  useEffect(() => {
    if (!selectedSessionId && workspaceSessions[0]?.config.id) {
      setSelectedSessionId(workspaceSessions[0].config.id);
    }
  }, [selectedSessionId, workspaceSessions]);

  async function handleCreateTerminal() {
    try {
      const session = await createSession({
        workspaceId: workspace.id,
      });
      setSelectedSessionId(session.config.id);
      setActivePane("terminal");
      toast.success(`Created SSH session "${session.config.name}"`);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function handleSave(): Promise<boolean> {
    const success = await workspaceFiles.saveCurrentFile();
    if (success) {
      toast.success("File saved");
    } else if (!workspaceFiles.conflictState) {
      toast.error(workspaceFiles.error ?? "Failed to save file");
    }
    return success;
  }

  async function handleRefreshEditor(): Promise<boolean> {
    const refreshed = await workspaceFiles.refreshCurrentFile();
    if (refreshed) {
      toast.info("Editor reloaded");
    }
    return refreshed;
  }

  const conflictState = workspaceFiles.conflictState;
  const tabButtonClassName = (pane: WorkspacePane, compact = false) => [
    "inline-flex min-h-[36px] items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition",
    compact ? "w-full justify-center lg:w-9 lg:px-0" : "w-full justify-center",
    activePane === pane
      ? "bg-gray-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-neutral-900 dark:text-gray-300 dark:hover:bg-neutral-800",
  ].join(" ");

  return (
    <ShellPanel
      title={`${workspace.name} editor`}
      description={workspace.directory}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "workspace", workspaceId: workspace.id })}>
          Back to workspace
        </Button>
      )}
      bodyClassName="h-full min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden lg:flex-row">
        <div
          data-testid="workspace-explorer-column"
          className={[
            "min-h-0 transition-[max-height,width] duration-200 ease-out",
            explorerCollapsed
              ? "max-h-none overflow-visible lg:h-full lg:w-14 lg:max-h-none lg:overflow-hidden"
              : "max-h-[35vh] overflow-hidden lg:h-full lg:w-[280px] lg:max-h-none",
          ].join(" ")}
        >
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="min-h-0 flex-1 overflow-hidden">
              <WorkspaceFileTree
                entriesByDirectory={workspaceFiles.directoryEntries}
                expandedDirectories={workspaceFiles.expandedDirectories}
                currentFilePath={workspaceFiles.currentFile?.path}
                showHiddenFiles={workspaceFiles.showHiddenFiles}
                loading={workspaceFiles.loadingTree}
                collapsed={explorerCollapsed}
                onRefresh={() => workspaceFiles.refreshTree("")}
                onToggleShowHiddenFiles={workspaceFiles.toggleShowHiddenFiles}
                onToggleCollapsed={() => setExplorerCollapsed((current) => !current)}
                onToggleDirectory={workspaceFiles.toggleDirectory}
                onOpenFile={async (path: string) => {
                  setActivePane("editor");
                  await workspaceFiles.openFile(path);
                }}
              />
            </div>
            <div
              data-testid="workspace-pane-switcher"
              className={[
                "shrink-0",
                explorerCollapsed
                  ? "grid grid-cols-2 gap-2 lg:flex lg:flex-col lg:items-center"
                  : "grid grid-cols-2 gap-2",
              ].join(" ")}
            >
              <button
                type="button"
                className={tabButtonClassName("editor", explorerCollapsed)}
                onClick={() => setActivePane("editor")}
                aria-pressed={activePane === "editor"}
                aria-label="Files"
                title="Files"
              >
                <FileIcon />
                {explorerCollapsed ? <span className="lg:sr-only">Files</span> : "Files"}
              </button>
              <button
                type="button"
                className={tabButtonClassName("terminal", explorerCollapsed)}
                onClick={() => setActivePane("terminal")}
                aria-pressed={activePane === "terminal"}
                aria-label="Terminals"
                title="Terminals"
              >
                <TerminalIcon />
                {explorerCollapsed ? <span className="lg:sr-only">Terminals</span> : "Terminals"}
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {activePane === "editor" ? (
            <WorkspaceEditorPanel
              filePath={workspaceFiles.currentFile?.path}
              value={workspaceFiles.editorContent}
              loading={workspaceFiles.loadingFile}
              saving={workspaceFiles.savingFile}
              dirty={workspaceFiles.isDirty}
              autoReloadedAt={workspaceFiles.autoReloadedAt}
              onChange={workspaceFiles.setEditorContent}
              onRefresh={handleRefreshEditor}
              onSave={handleSave}
            />
          ) : (
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Integrated terminal</h2>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <select
                    value={selectedSessionId}
                    onChange={(event) => setSelectedSessionId(event.target.value)}
                    disabled={!hasSshTransport || workspaceSessions.length === 0}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
                    aria-label="Select workspace SSH session"
                  >
                    <option value="">Select SSH session</option>
                    {workspaceSessions.map((session) => (
                      <option key={session.config.id} value={session.config.id}>
                        {session.config.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCreateTerminal()}
                    disabled={!hasSshTransport}
                  >
                    New terminal
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                {selectedSessionId ? (
                  <SshSessionDetails
                    sshSessionId={selectedSessionId}
                    showBackButton={false}
                    headerOffsetClassName={headerOffsetClassName}
                    forcedFocusMode={true}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-4 text-sm text-gray-500 dark:text-gray-400">
                    {hasSshTransport
                      ? "Choose an existing SSH session or create a new one."
                      : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable."}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>

      <WorkspaceFileConflictModal
        isOpen={conflictState?.kind === "save_conflict"}
        title="File changed outside the editor"
        message={conflictState?.message ?? ""}
        confirmLabel="Overwrite file"
        onCancel={workspaceFiles.dismissConflict}
        onConfirm={() => {
          void workspaceFiles.retrySaveWithOverwrite().then((success) => {
            if (success) {
              toast.success("File overwritten with local changes");
            }
          });
        }}
      />

      <WorkspaceFileConflictModal
        isOpen={conflictState?.kind === "reload_conflict"}
        title="Reload required"
        message={conflictState?.message ?? ""}
        confirmLabel="Discard local changes and reload"
        onCancel={workspaceFiles.dismissConflict}
        onConfirm={() => {
          void workspaceFiles.discardLocalChangesAndReload().then((success) => {
            if (success) {
              toast.info("Reloaded file from disk");
            }
          });
        }}
      />
    </ShellPanel>
  );
}
