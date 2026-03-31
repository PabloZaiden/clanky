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

export function WorkspaceFilesView({
  workspace,
  sessions,
  headerOffsetClassName,
  createSession,
  onNavigate,
}: WorkspaceFilesViewProps) {
  const toast = useToast();
  const workspaceFiles = useWorkspaceFiles(workspace.id);
  const [showTerminal, setShowTerminal] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const workspaceSessions = useMemo(
    () => sessions.filter((session) => session.config.workspaceId === workspace.id),
    [sessions, workspace.id],
  );

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
      setShowTerminal(true);
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

  return (
    <ShellPanel
      title={`${workspace.name} editor`}
      description={workspace.directory}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <>
          <Button variant="ghost" size="sm" onClick={() => onNavigate({ view: "workspace", workspaceId: workspace.id })}>
            Back to workspace
          </Button>
          <Button
            variant={showTerminal ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowTerminal((current) => !current)}
            icon={<TerminalIcon />}
          >
            {showTerminal ? "Hide terminal" : "Show terminal"}
          </Button>
        </>
      )}
      bodyClassName="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]"
    >
      <div className="min-h-[300px] lg:min-h-0">
        <WorkspaceFileTree
          entriesByDirectory={workspaceFiles.directoryEntries}
          expandedDirectories={workspaceFiles.expandedDirectories}
          currentFilePath={workspaceFiles.currentFile?.path}
          loading={workspaceFiles.loadingTree}
          onRefresh={() => workspaceFiles.refreshTree("")}
          onToggleDirectory={workspaceFiles.toggleDirectory}
          onOpenFile={workspaceFiles.openFile}
        />
      </div>

      <div className="flex min-h-[520px] min-w-0 flex-col gap-4">
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

        <section className="flex min-h-[260px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Integrated terminal</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Reuses workspace SSH sessions where available.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={selectedSessionId}
                onChange={(event) => setSelectedSessionId(event.target.value)}
                disabled={workspace.serverSettings.agent.transport !== "ssh" || workspaceSessions.length === 0}
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
                disabled={workspace.serverSettings.agent.transport !== "ssh"}
              >
                New terminal
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {showTerminal && selectedSessionId ? (
              <SshSessionDetails
                sshSessionId={selectedSessionId}
                showBackButton={false}
                headerOffsetClassName={headerOffsetClassName}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-sm text-gray-500 dark:text-gray-400">
                {workspace.serverSettings.agent.transport === "ssh"
                  ? "Choose an existing SSH session or create a new one."
                  : "This workspace uses stdio transport, so embedded SSH terminal sessions are unavailable."}
              </div>
            )}
          </div>
        </section>
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
