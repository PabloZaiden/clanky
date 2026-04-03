import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { SshSession } from "../../types";
import type { SshServerSession } from "../../types/ssh-server";
import { useFileExplorer, useToast } from "../../hooks";
import { storeSshServerPassword } from "../../lib/ssh-browser-credentials";
import { SshSessionDetails } from "../SshSessionDetails";
import { Button, GearIcon, Modal } from "../common";
import { requireFileExplorerServerCredentialToken } from "../../hooks/workspaceFileActions";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import { WorkspaceFileTree } from "../workspace-files/file-tree";
import { WorkspaceEditorPanel } from "../workspace-files/editor-panel";
import { WorkspaceFileConflictModal } from "../workspace-files/conflict-modal";
import { ServerPasswordModal } from "./server-password-modal";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";

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

type ExplorerPane = "editor" | "terminal";
type ExplorerSession = SshSession | SshServerSession;

function isServerCredentialErrorCode(errorCode: string | null): boolean {
  return errorCode === "missing_ssh_credential" || errorCode === "invalid_ssh_credential";
}

interface FileExplorerViewProps {
  title: string;
  description: string;
  defaultRootDirectory: string;
  backLabel: string;
  backRoute: ShellRoute;
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
  target: { type: "workspace" | "server"; id: string; startDirectory?: string };
  sessions: ExplorerSession[];
  hasTerminal: boolean;
  emptyTerminalMessage: string;
  terminalSelectLabel: string;
  onCreateTerminal: () => Promise<ExplorerSession>;
  testIdPrefix: "workspace" | "server";
  credentialPromptName?: string;
}

export function FileExplorerView({
  title,
  description,
  defaultRootDirectory,
  backLabel,
  backRoute,
  headerOffsetClassName,
  onNavigate,
  target,
  sessions,
  hasTerminal,
  emptyTerminalMessage,
  terminalSelectLabel,
  onCreateTerminal,
  testIdPrefix,
  credentialPromptName,
}: FileExplorerViewProps) {
  const toast = useToast();
  const hasStoredServerCredential = target.type === "server"
    ? getStoredSshServerCredential(target.id) !== null
    : true;
  const [startupBlockedByPassword, setStartupBlockedByPassword] = useState(
    target.type === "server" && !hasStoredServerCredential,
  );
  const [serverPasswordModalOpen, setServerPasswordModalOpen] = useState(
    target.type === "server" && !hasStoredServerCredential,
  );
  const [serverPassword, setServerPassword] = useState("");
  const [serverPasswordError, setServerPasswordError] = useState<string | null>(null);
  const [serverPasswordSubmitting, setServerPasswordSubmitting] = useState(false);
  const explorer = useFileExplorer(target, { enabled: !startupBlockedByPassword });
  const [activePane, setActivePane] = useState<ExplorerPane>("editor");
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [rootPickerOpen, setRootPickerOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const activeRootDirectory = target.startDirectory?.trim() || defaultRootDirectory.trim();
  const [rootInputValue, setRootInputValue] = useState(activeRootDirectory);
  const selectableSessions = useMemo(
    () => sessions.map((session) => ({
      id: session.config.id,
      name: session.config.name,
    })),
    [sessions],
  );

  useEffect(() => {
    if (!selectedSessionId && selectableSessions[0]?.id) {
      setSelectedSessionId(selectableSessions[0].id);
    }
  }, [selectableSessions, selectedSessionId]);

  useEffect(() => {
    setRootInputValue(activeRootDirectory);
  }, [activeRootDirectory]);

  useEffect(() => {
    const requiresPasswordBeforeStart = target.type === "server" && !hasStoredServerCredential;
    setStartupBlockedByPassword(requiresPasswordBeforeStart);
    setServerPasswordModalOpen(requiresPasswordBeforeStart);
    setServerPassword("");
    setServerPasswordError(null);
    setServerPasswordSubmitting(false);
  }, [hasStoredServerCredential, target.id, target.type]);

  useEffect(() => {
    if (target.type !== "server") {
      return;
    }

    if (
      isServerCredentialErrorCode(explorer.errorCode)
    ) {
      setServerPassword("");
      setServerPasswordError(explorer.error);
      setServerPasswordModalOpen(true);
    }
  }, [explorer.error, explorer.errorCode, target.type]);

  async function handleCreateTerminal() {
    try {
      const session = await onCreateTerminal();
      setSelectedSessionId(session.config.id);
      setActivePane("terminal");
      toast.success(`Created SSH session "${session.config.name}"`);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function handleSave(): Promise<boolean> {
    const success = await explorer.saveCurrentFile();
    if (success) {
      toast.success("File saved");
    } else if (!explorer.conflictState) {
      toast.error(explorer.error ?? "Failed to save file");
    }
    return success;
  }

  async function handleRefreshEditor(): Promise<boolean> {
    const refreshed = await explorer.refreshCurrentFile();
    if (refreshed) {
      toast.info("Editor reloaded");
    }
    return refreshed;
  }

  const conflictState = explorer.conflictState;
  const normalizedRootInputValue = rootInputValue.trim();
  const rootChanged = normalizedRootInputValue !== activeRootDirectory;
  const tabButtonClassName = (pane: ExplorerPane, compact = false) => [
    "inline-flex min-h-[36px] items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition",
    compact ? "w-full justify-center lg:w-9 lg:px-0" : "w-full justify-center",
    activePane === pane
      ? "bg-gray-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-neutral-900 dark:text-gray-300 dark:hover:bg-neutral-800",
    ].join(" ");

  function buildExplorerRoute(startDirectory?: string): ShellRoute {
    if (target.type === "workspace") {
      return {
        view: "workspace-files",
        workspaceId: target.id,
        startDirectory,
      };
    }
    return {
      view: "server-files",
      serverId: target.id,
      startDirectory,
    };
  }

  const applyRootDirectory = useCallback((directory: string) => {
    const normalizedDirectory = directory.trim();
    const nextStartDirectory = normalizedDirectory && normalizedDirectory !== defaultRootDirectory.trim()
      ? normalizedDirectory
      : undefined;
    onNavigate(buildExplorerRoute(nextStartDirectory));
  }, [defaultRootDirectory, onNavigate, target.id, target.type]);

  const openRootPicker = useCallback(() => {
    setRootInputValue(activeRootDirectory);
    setRootPickerOpen(true);
  }, [activeRootDirectory]);

  const closeRootPicker = useCallback(() => {
    setRootInputValue(activeRootDirectory);
    setRootPickerOpen(false);
  }, [activeRootDirectory]);

  const applyRootAndClose = useCallback((directory: string) => {
    applyRootDirectory(directory);
    setRootPickerOpen(false);
  }, [applyRootDirectory]);

  const handleRootSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyRootAndClose(rootInputValue);
  }, [applyRootAndClose, rootInputValue]);

  const handleToggleExplorerCollapsed = useCallback(() => {
    setExplorerCollapsed((current) => !current);
  }, []);

  const handleCloseServerPasswordModal = useCallback(() => {
    setServerPasswordModalOpen(false);
    setServerPassword("");
    setServerPasswordError(null);
    if (startupBlockedByPassword) {
      onNavigate(backRoute);
    }
  }, [backRoute, onNavigate, startupBlockedByPassword]);

  const handleSubmitServerPassword = useCallback(async () => {
    if (target.type !== "server") {
      return;
    }

    const trimmedPassword = serverPassword.trim();
    if (!trimmedPassword) {
      setServerPasswordError("Enter the SSH password for this server.");
      return;
    }

    try {
      setServerPasswordSubmitting(true);
      setServerPasswordError(null);
      await storeSshServerPassword(target.id, trimmedPassword);
      await requireFileExplorerServerCredentialToken(target.id);
      const shouldStartExplorer = startupBlockedByPassword;
      setStartupBlockedByPassword(false);
      setServerPassword("");
      setServerPasswordModalOpen(false);

      if (!shouldStartExplorer) {
        await explorer.refreshTree(explorer.currentDirectory);
      }
    } catch (error) {
      setServerPasswordError(error instanceof Error ? error.message : String(error));
    } finally {
      setServerPasswordSubmitting(false);
    }
  }, [explorer, serverPassword, startupBlockedByPassword, target]);

  const handleOpenFile = useCallback(async (path: string) => {
    setActivePane("editor");
    await explorer.openFile(path);
  }, [explorer.openFile]);

  const explorerToolbarActions = useMemo(() => (
    <Button
      variant="ghost"
      size="sm"
      onClick={openRootPicker}
      aria-label="Change explorer root"
      title="Change explorer root"
      className="w-9 px-0"
      icon={<GearIcon size="h-4 w-4" />}
    >
      <span className="sr-only">Change explorer root</span>
    </Button>
  ), [openRootPicker]);

  return (
    <ShellPanel
      title={title}
      description={description}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
      actions={(
        <Button variant="ghost" size="sm" onClick={() => onNavigate(backRoute)}>
          {backLabel}
        </Button>
      )}
      bodyClassName="h-full min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden lg:flex-row">
        <div
          data-testid={`${testIdPrefix}-explorer-column`}
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
                entriesByDirectory={explorer.directoryEntries}
                expandedDirectories={explorer.expandedDirectories}
                currentFilePath={explorer.currentFile?.path}
                showHiddenFiles={explorer.showHiddenFiles}
                loading={explorer.loadingTree}
                collapsed={explorerCollapsed}
                toolbarActions={explorerToolbarActions}
                onRefresh={explorer.refreshTree}
                onToggleShowHiddenFiles={explorer.toggleShowHiddenFiles}
                onToggleCollapsed={handleToggleExplorerCollapsed}
                onToggleDirectory={explorer.toggleDirectory}
                onOpenFile={handleOpenFile}
              />
            </div>
            <div
              data-testid={`${testIdPrefix}-pane-switcher`}
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
              filePath={explorer.currentFile?.path}
              value={explorer.editorContent}
              loading={explorer.loadingFile}
              saving={explorer.savingFile}
              dirty={explorer.isDirty}
              autoReloadedAt={explorer.autoReloadedAt}
              onChange={explorer.setEditorContent}
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
                    disabled={!hasTerminal || selectableSessions.length === 0}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
                    aria-label={terminalSelectLabel}
                  >
                    <option value="">Select SSH session</option>
                    {selectableSessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleCreateTerminal()}
                    disabled={!hasTerminal}
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
                    {emptyTerminalMessage}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
        </div>
      </div>

      <WorkspaceFileConflictModal
        isOpen={conflictState?.kind === "save_conflict"}
        title="File changed outside the editor"
        message={conflictState?.message ?? ""}
        confirmLabel="Overwrite file"
        onCancel={explorer.dismissConflict}
        onConfirm={() => {
          void explorer.retrySaveWithOverwrite().then((success) => {
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
        onCancel={explorer.dismissConflict}
        onConfirm={() => {
          void explorer.discardLocalChangesAndReload().then((success) => {
            if (success) {
              toast.info("Reloaded file from disk");
            }
          });
        }}
      />

      <Modal
        isOpen={rootPickerOpen}
        onClose={closeRootPicker}
        title="Change explorer root"
        description="Choose the directory where the file tree should start."
        size="md"
        footer={(
          <>
            <Button variant="ghost" onClick={closeRootPicker}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              disabled={activeRootDirectory === defaultRootDirectory.trim()}
              onClick={() => applyRootAndClose(defaultRootDirectory)}
            >
              Reset root
            </Button>
            <Button
              type="submit"
              form="explorer-root-picker-form"
              variant="secondary"
              disabled={!normalizedRootInputValue || !rootChanged}
            >
              Apply root
            </Button>
          </>
        )}
      >
        <form id="explorer-root-picker-form" className="flex flex-col gap-4" onSubmit={handleRootSubmit}>
          <div className="space-y-1">
            <label
              htmlFor={`${testIdPrefix}-explorer-root-directory`}
              className="text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              Explorer root directory
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Default: {defaultRootDirectory}
            </p>
          </div>
          <input
            id={`${testIdPrefix}-explorer-root-directory`}
            type="text"
            value={rootInputValue}
            onChange={(event) => setRootInputValue(event.target.value)}
            aria-label="Explorer root directory"
            placeholder={defaultRootDirectory}
            className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
          />
        </form>
      </Modal>

      <ServerPasswordModal
        isOpen={serverPasswordModalOpen}
        serverName={credentialPromptName ?? title}
        password={serverPassword}
        error={serverPasswordError}
        submitting={serverPasswordSubmitting}
        onPasswordChange={setServerPassword}
        onClose={handleCloseServerPasswordModal}
        onSubmit={handleSubmitServerPassword}
      />
    </ShellPanel>
  );
}
