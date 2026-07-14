import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentType, type FormEvent } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { SshSession, WorkspaceFileEntry } from "@/shared";
import type { SshServerSession } from "@/shared/ssh-server";
import { useFileExplorer, useFileExplorerFullTreePreference, useToast } from "../../hooks";
import { storeSshServerPassword } from "../../lib/ssh-browser-credentials";
import { formatFileSize, writeTextToClipboard } from "../../utils";
import { SshSessionDetails, type SshSessionDetailsProps } from "../SshSessionDetails";
import { ConfirmModal, Modal, Panel } from "@pablozaiden/webapp/web";
import { Button } from "../common";
import type { CodeExplorerTerminalOptions } from "./code-explorer-targets";
import { requireFileExplorerServerCredentialToken } from "../../hooks/workspaceFileActions";
import { WorkspaceFileTree } from "../workspace-files/file-tree";
import { WorkspaceEditorPanel } from "../workspace-files/editor-panel";
import { WorkspaceImagePreviewPanel } from "../workspace-files/image-preview-panel";
import { LargeFileWarningPanel } from "../workspace-files/large-file-warning-panel";
import { WorkspaceFileConflictModal } from "../workspace-files/conflict-modal";
import { ServerPasswordModal } from "./server-password-modal";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import {
  getFileExplorerDownloadUrl,
} from "../../hooks/workspaceFileActions";

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

function triggerBrowserDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "download";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

interface FileExplorerViewProps {
  title: string;
  description: string;
  defaultRootDirectory: string;
  backLabel: string;
  backRoute: WebAppRoute;
  onNavigate: (route: WebAppRoute) => void;
  target: { type: "workspace" | "server"; id: string; startDirectory?: string };
  sessions: ExplorerSession[];
  hasTerminal: boolean;
  emptyTerminalMessage: string;
  terminalSelectLabel: string;
  onCreateTerminal: (options?: CodeExplorerTerminalOptions) => Promise<ExplorerSession>;
  canChooseTerminalTmux: boolean;
  testIdPrefix: "workspace" | "server";
  credentialPromptName?: string;
  initialFilePath?: string;
  buildRoute?: (startDirectory?: string) => WebAppRoute;
  headerActions?: React.ReactNode;
  sshSessionDetailsComponent?: ComponentType<SshSessionDetailsProps>;
}

export function FileExplorerView({
  title,
  description,
  defaultRootDirectory,
  backLabel,
  backRoute,
  onNavigate,
  target,
  sessions,
  hasTerminal,
  emptyTerminalMessage,
  terminalSelectLabel,
  onCreateTerminal,
  canChooseTerminalTmux,
  testIdPrefix,
  credentialPromptName,
  initialFilePath,
  buildRoute,
  headerActions,
  sshSessionDetailsComponent: SshSessionDetailsComponent = SshSessionDetails,
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
  const fullTreePreference = useFileExplorerFullTreePreference();
  const explorer = useFileExplorer(target, {
    enabled: !startupBlockedByPassword && !fullTreePreference.loading,
    loadFullTree: fullTreePreference.enabled,
  });
  const [activePane, setActivePane] = useState<ExplorerPane>("editor");
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [rootPickerOpen, setRootPickerOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameInputValue, setRenameInputValue] = useState("");
  const [renamingNode, setRenamingNode] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletingNode, setDeletingNode] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [tmuxPromptOpen, setTmuxPromptOpen] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [downloadingFilePath, setDownloadingFilePath] = useState<string | null>(null);
  const [openingLargeFile, setOpeningLargeFile] = useState(false);
  const canPromptForTerminalTmux = hasTerminal && canChooseTerminalTmux;
  const activeRootDirectory = target.startDirectory?.trim() || defaultRootDirectory.trim();
  const selectedFilePath = explorer.currentFile?.path;
  const selectedFileAbsolutePath = explorer.currentFile?.absolutePath;
  const [rootInputValue, setRootInputValue] = useState(activeRootDirectory);
  const [loadFullTreeInput, setLoadFullTreeInput] = useState(fullTreePreference.enabled);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const lastAutoOpenedFileRef = useRef<string | null>(null);
  const selectableSessions = useMemo(
    () => sessions.map((session) => ({
      id: session.config.id,
      name: session.config.name,
    })),
    [sessions],
  );
  const selectedSessionName = useMemo(
    () => selectableSessions.find((session) => session.id === selectedSessionId)?.name ?? "",
    [selectableSessions, selectedSessionId],
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
    setLoadFullTreeInput(fullTreePreference.enabled);
  }, [fullTreePreference.enabled]);

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

  useEffect(() => {
    if (!canPromptForTerminalTmux) {
      setTmuxPromptOpen(false);
    }
  }, [canPromptForTerminalTmux]);

  async function createTerminal(options?: CodeExplorerTerminalOptions) {
    try {
      setCreatingTerminal(true);
      const session = await onCreateTerminal(options);
      setSelectedSessionId(session.config.id);
      setActivePane("terminal");
      setTmuxPromptOpen(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setCreatingTerminal(false);
    }
  }

  function handleCreateTerminal() {
    if (canPromptForTerminalTmux) {
      setTmuxPromptOpen(true);
      return;
    }

    void createTerminal();
  }

  async function handleSave(): Promise<boolean> {
    const success = await explorer.saveCurrentFile();
    if (!success && !explorer.conflictState) {
      toast.error(explorer.error ?? "Failed to save file");
    }
    return success;
  }

  async function handleRefreshEditor(): Promise<boolean> {
    return await explorer.refreshCurrentFile();
  }

  const conflictState = explorer.conflictState;
  const normalizedRootInputValue = rootInputValue.trim();
  const rootChanged = normalizedRootInputValue !== activeRootDirectory;
  const modeChanged = loadFullTreeInput !== fullTreePreference.enabled;
  const pickerHasChanges = rootChanged || modeChanged;
  const tabButtonClassName = (pane: ExplorerPane, compact = false) => [
    "inline-flex min-h-[36px] items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition",
    compact ? "w-full justify-center lg:w-9 lg:px-0" : "w-full justify-center",
    activePane === pane
      ? "bg-gray-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-neutral-900 dark:text-gray-300 dark:hover:bg-neutral-800",
    ].join(" ");

  function buildExplorerRoute(startDirectory?: string): WebAppRoute {
    if (buildRoute) {
      return buildRoute(startDirectory);
    }
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
  }, [buildRoute, defaultRootDirectory, onNavigate, target.id, target.type]);

  const openRootPicker = useCallback(() => {
    setRootInputValue(activeRootDirectory);
    setLoadFullTreeInput(fullTreePreference.enabled);
    setRootPickerOpen(true);
  }, [activeRootDirectory, fullTreePreference.enabled]);

  const closeRootPicker = useCallback(() => {
    setRootInputValue(activeRootDirectory);
    setLoadFullTreeInput(fullTreePreference.enabled);
    setRootPickerOpen(false);
  }, [activeRootDirectory, fullTreePreference.enabled]);

  const applyRootAndClose = useCallback(async (directory: string) => {
    const nextRootChanged = directory.trim() !== activeRootDirectory;

    if (modeChanged) {
      try {
        await fullTreePreference.setEnabled(loadFullTreeInput);
      } catch (error) {
        toast.error(String(error));
        return;
      }
    }

    if (nextRootChanged) {
      applyRootDirectory(directory);
      setRootPickerOpen(false);
      return;
    }

    setRootPickerOpen(false);
  }, [
    applyRootDirectory,
    fullTreePreference,
    loadFullTreeInput,
    activeRootDirectory,
    modeChanged,
    toast,
  ]);

  const handleRootSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await applyRootAndClose(rootInputValue);
  }, [applyRootAndClose, rootInputValue]);

  const handleToggleExplorerCollapsed = useCallback(() => {
    setExplorerCollapsed((current) => !current);
  }, []);

  const handleCopySelectedFilePath = useCallback(async () => {
    if (!selectedFileAbsolutePath) {
      toast.error("Absolute file path is unavailable for the selected file.");
      return;
    }

    try {
      await writeTextToClipboard(selectedFileAbsolutePath);
      toast.success("Copied file path");
    } catch (error) {
      toast.error(`Failed to copy file path: ${String(error)}`);
    }
  }, [selectedFileAbsolutePath, toast]);

  const handleDownloadFile = useCallback(async (file: WorkspaceFileEntry | null = explorer.currentFile) => {
    if (!file) {
      toast.error("Select a file to download.");
      return;
    }

    try {
      setDownloadingFilePath(file.path);
      if (file.kind !== "file") {
        toast.error("Select a file to download.");
        return;
      }
      const downloadUrl = await getFileExplorerDownloadUrl(target, file.path, {
        startDirectory: target.startDirectory,
      });
      triggerBrowserDownload(downloadUrl, file.name);
      toast.success(`Started download: ${file.name} (${formatFileSize(file.size)})`);
    } catch (error) {
      toast.error(`Failed to download file: ${String(error)}`);
    } finally {
      setDownloadingFilePath(null);
    }
  }, [explorer.currentFile, target, toast]);

  const handleOpenLargeFileInEditor = useCallback(async (file: WorkspaceFileEntry | null = explorer.largeFileWarning?.file ?? null) => {
    if (!file) {
      toast.error("Large file warning is no longer available.");
      return;
    }

    try {
      setOpeningLargeFile(true);
      const opened = await explorer.openLargeFileInEditor(file.path);
      if (!opened) {
        toast.error("Large file warning is no longer available.");
      }
    } catch (error) {
      toast.error(`Failed to open large file: ${String(error)}`);
    } finally {
      setOpeningLargeFile(false);
    }
  }, [explorer, toast]);

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

  const selectedNode = explorer.selectedNode;

  const blockDirtySelectedFileMutation = useCallback(() => {
    if (explorer.isDirty && selectedNode?.path === explorer.currentFile?.path) {
      toast.error("Save or discard local changes before modifying this file.");
      return true;
    }
    return false;
  }, [explorer.currentFile?.path, explorer.isDirty, selectedNode?.path, toast]);

  const openRenameModal = useCallback(() => {
    if (!selectedNode) {
      toast.error("Select a file or directory to rename.");
      return;
    }
    if (blockDirtySelectedFileMutation()) {
      return;
    }
    setRenameInputValue(selectedNode.name);
    setRenameModalOpen(true);
  }, [blockDirtySelectedFileMutation, selectedNode, toast]);

  const closeRenameModal = useCallback(() => {
    setRenameModalOpen(false);
    setRenameInputValue("");
  }, []);

  const handleRenameSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = renameInputValue.trim();
    if (!trimmedName) {
      toast.error("Enter a new name.");
      return;
    }
    try {
      setRenamingNode(true);
      const renamedFile = await explorer.renameSelectedNode(trimmedName);
      if (!renamedFile) {
        toast.error(explorer.error ?? "Failed to rename selected item.");
        return;
      }
      toast.success(`Renamed to ${renamedFile.name}`);
      closeRenameModal();
    } finally {
      setRenamingNode(false);
    }
  }, [closeRenameModal, explorer, renameInputValue, toast]);

  const openDeleteModal = useCallback(() => {
    if (!selectedNode) {
      toast.error("Select a file or directory to delete.");
      return;
    }
    if (blockDirtySelectedFileMutation()) {
      return;
    }
    setDeleteModalOpen(true);
  }, [blockDirtySelectedFileMutation, selectedNode, toast]);

  const handleConfirmDelete = useCallback(async () => {
    if (!selectedNode) {
      return;
    }
    try {
      setDeletingNode(true);
      const deleted = await explorer.deleteSelectedNode();
      if (!deleted) {
        toast.error(explorer.error ?? "Failed to delete selected item.");
        return;
      }
      toast.success(`Deleted ${selectedNode.name}`);
      setDeleteModalOpen(false);
    } finally {
      setDeletingNode(false);
    }
  }, [explorer, selectedNode, toast]);

  const handleUploadFile = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }
    try {
      setUploadingFile(true);
      const uploadedFile = await explorer.uploadFileToSelectedDirectory(file);
      if (!uploadedFile) {
        toast.error(explorer.error ?? "Failed to upload file.");
        return;
      }
      toast.success(`Uploaded ${uploadedFile.name}`);
    } finally {
      setUploadingFile(false);
    }
  }, [explorer, toast]);

  useEffect(() => {
    if (
      !initialFilePath
      || fullTreePreference.loading
      || startupBlockedByPassword
      || explorer.loadingTree
      || explorer.loadingFile
      || explorer.pendingFilePath === initialFilePath
      || explorer.currentFile?.path === initialFilePath
    ) {
      return;
    }

    if (explorer.currentFile && explorer.isDirty && explorer.currentFile.path !== initialFilePath) {
      return;
    }

    const routeKey = [
      target.type,
      target.id,
      target.startDirectory ?? defaultRootDirectory,
      initialFilePath,
    ].join("::");
    if (lastAutoOpenedFileRef.current === routeKey) {
      return;
    }

    lastAutoOpenedFileRef.current = routeKey;
    void handleOpenFile(initialFilePath);
  }, [
    defaultRootDirectory,
    explorer.currentFile,
    explorer.isDirty,
    explorer.loadingFile,
    explorer.loadingTree,
    explorer.pendingFilePath,
    handleOpenFile,
    initialFilePath,
    fullTreePreference.loading,
    startupBlockedByPassword,
    target.id,
    target.startDirectory,
    target.type,
  ]);

  return (
    <Panel
      className="flex h-full min-h-0 flex-col overflow-hidden !border-0 !bg-transparent !p-0"
      description={description}
      actions={(
        <>
          {headerActions}
          <div className="hidden flex-shrink-0 sm:block">
            <Button
              variant="ghost"
              size="sm"
              className="whitespace-nowrap"
              onClick={() => onNavigate(backRoute)}
            >
              {backLabel}
            </Button>
          </div>
        </>
      )}
    >
      <div
        data-testid={`${testIdPrefix}-shell-body`}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6 sm:py-5 lg:px-8 lg:py-6"
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
                currentFilePath={selectedFilePath}
                selectedNodePath={explorer.selectedNode?.path}
                showHiddenFiles={explorer.showHiddenFiles}
                loading={explorer.loadingTree}
                error={explorer.error}
                collapsed={explorerCollapsed}
                onOpenRootPicker={openRootPicker}
                onRefresh={explorer.refreshTree}
                onToggleShowHiddenFiles={explorer.toggleShowHiddenFiles}
                onCopySelectedFilePath={handleCopySelectedFilePath}
                onDownloadSelectedFile={handleDownloadFile}
                onUploadFile={handleUploadFile}
                onRenameSelectedNode={openRenameModal}
                onDeleteSelectedNode={openDeleteModal}
                onToggleCollapsed={handleToggleExplorerCollapsed}
                onToggleDirectory={explorer.toggleDirectory}
                onOpenFile={handleOpenFile}
                canCopySelectedFilePath={Boolean(selectedFileAbsolutePath)}
                canDownloadSelectedFile={Boolean(explorer.currentFile)}
                canUploadFile={!explorer.loadingTree && !uploadingFile}
                canRenameSelectedNode={Boolean(explorer.selectedNode) && !renamingNode}
                canDeleteSelectedNode={Boolean(explorer.selectedNode) && !deletingNode}
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
            explorer.largeFileWarning ? (
              <LargeFileWarningPanel
                file={explorer.largeFileWarning.file}
                downloading={downloadingFilePath === explorer.largeFileWarning.file.path}
                opening={openingLargeFile}
                onDownload={() => handleDownloadFile(explorer.largeFileWarning?.file ?? null)}
                onOpenInCodeExplorer={() => handleOpenLargeFileInEditor(explorer.largeFileWarning?.file ?? null)}
              />
            ) : explorer.currentFile?.isImage ? (
              <WorkspaceImagePreviewPanel
                filePath={explorer.currentFile.path}
                pendingFilePath={explorer.pendingFilePath}
                imagePreviewUrl={explorer.imagePreviewUrl}
                loading={explorer.loadingFile}
                autoReloadedAt={explorer.autoReloadedAt}
                onRefresh={handleRefreshEditor}
              />
            ) : (
              <WorkspaceEditorPanel
                filePath={explorer.currentFile?.path}
                pendingFilePath={explorer.pendingFilePath}
                value={explorer.editorContent}
                loading={explorer.loadingFile}
                saving={explorer.savingFile}
                dirty={explorer.isDirty}
                autoReloadedAt={explorer.autoReloadedAt}
                onChange={explorer.setEditorContent}
                onRefresh={handleRefreshEditor}
                onSave={handleSave}
              />
            )
          ) : (
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
              <div className="flex flex-col items-stretch gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800 md:flex-row md:items-center md:justify-between">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Integrated terminal</h2>
                <div
                  data-testid={`${testIdPrefix}-terminal-controls`}
                  className="flex min-w-0 flex-col items-stretch gap-2 md:flex-row md:items-center md:justify-end"
                >
                  <select
                    data-testid={`${testIdPrefix}-terminal-select`}
                    value={selectedSessionId}
                    onChange={(event) => setSelectedSessionId(event.target.value)}
                    disabled={!hasTerminal || selectableSessions.length === 0}
                    className="min-w-0 w-full max-w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 md:w-[20rem] lg:w-[24rem] dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
                    aria-label={terminalSelectLabel}
                    title={selectedSessionName || undefined}
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
                    onClick={handleCreateTerminal}
                    disabled={!hasTerminal || creatingTerminal}
                  >
                    New terminal
                  </Button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {selectedSessionId ? (
                  <SshSessionDetailsComponent
                    sshSessionId={selectedSessionId}
                    showBackButton={false}
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
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          void handleUploadInputChange(event);
        }}
        aria-label="Upload file"
      />

      {explorer.uploadProgress && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100">
          Uploading {formatFileSize(explorer.uploadProgress.bytesUploaded)} of {formatFileSize(explorer.uploadProgress.totalBytes)}
        </div>
      )}

      <Modal
        isOpen={renameModalOpen}
        onClose={closeRenameModal}
        title="Rename selected item"
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={closeRenameModal} disabled={renamingNode}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="file-explorer-rename-form"
              variant="secondary"
              loading={renamingNode}
              disabled={!renameInputValue.trim()}
            >
              Rename
            </Button>
          </>
        )}
      >
        <form id="file-explorer-rename-form" className="space-y-3" onSubmit={handleRenameSubmit}>
          <label className="block text-sm font-medium text-gray-900 dark:text-gray-100" htmlFor="file-explorer-rename-input">
            New name
          </label>
          <input
            id="file-explorer-rename-input"
            type="text"
            value={renameInputValue}
            onChange={(event) => setRenameInputValue(event.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100"
            autoFocus
          />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={() => {
          void handleConfirmDelete();
        }}
        title="Delete selected item"
        message={selectedNode
          ? `Delete ${selectedNode.kind} "${selectedNode.name}"?${selectedNode.kind === "directory" ? " This will delete its contents." : ""}`
          : "Delete the selected item?"}
        confirmLabel="Delete"
        loading={deletingNode}
        variant="danger"
      />

      <Modal
        isOpen={tmuxPromptOpen && canPromptForTerminalTmux}
        onClose={() => setTmuxPromptOpen(false)}
        title="Create terminal"
        description="Choose how this terminal should start."
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setTmuxPromptOpen(false)} disabled={creatingTerminal}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              loading={creatingTerminal}
              onClick={() => {
                void createTerminal({ useTmux: false });
              }}
            >
              Without tmux
            </Button>
            <Button
              variant="primary"
              loading={creatingTerminal}
              onClick={() => {
                void createTerminal({ useTmux: true });
              }}
            >
              With tmux
            </Button>
          </>
        )}
      >
        <div className="space-y-3 text-sm text-gray-600 dark:text-gray-300">
          <p>Start this terminal in tmux when available?</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Choose without tmux if you want a normal interactive shell without trying tmux first.
          </p>
        </div>
      </Modal>

      <WorkspaceFileConflictModal
        isOpen={conflictState?.kind === "save_conflict"}
        title="File changed outside the code explorer"
        message={conflictState?.message ?? ""}
        confirmLabel="Overwrite file"
        onCancel={explorer.dismissConflict}
        onConfirm={() => {
          void explorer.retrySaveWithOverwrite();
        }}
      />

      <WorkspaceFileConflictModal
        isOpen={conflictState?.kind === "reload_conflict"}
        title="Reload required"
        message={conflictState?.message ?? ""}
        confirmLabel="Discard local changes and reload"
        onCancel={explorer.dismissConflict}
        onConfirm={() => {
          void explorer.discardLocalChangesAndReload();
        }}
      />

      <Modal
        isOpen={rootPickerOpen}
        onClose={closeRootPicker}
        title="Change explorer root"
        size="md"
        footer={(
           <>
             <Button variant="ghost" onClick={closeRootPicker}>
               Cancel
             </Button>
             <Button
               variant="ghost"
               disabled={activeRootDirectory === defaultRootDirectory.trim()}
               onClick={() => {
                 void applyRootAndClose(defaultRootDirectory);
               }}
              >
               Reset root
              </Button>
              <Button
               type="submit"
               form="explorer-root-picker-form"
               variant="secondary"
               disabled={!normalizedRootInputValue || !pickerHasChanges || fullTreePreference.loading || fullTreePreference.saving}
              >
               Apply changes
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
          <label className="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-3 dark:border-gray-700">
            <input
              type="checkbox"
              checked={loadFullTreeInput}
              onChange={(event) => setLoadFullTreeInput(event.target.checked)}
              disabled={fullTreePreference.loading || fullTreePreference.saving}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Load everything at once
            </span>
          </label>
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
    </Panel>
  );
}
