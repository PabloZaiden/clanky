import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Workspace } from "@/shared";
import type { CreateChatRequest, ImportExistingChatRequest } from "@/contracts";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { apiRequest } from "../../lib/api-client";
import {
  getStoredChatModelPreference,
  saveStoredChatModelPreference,
} from "../../lib/model-selection-preferences";
import {
  makeModelKey,
  ModelSelector,
  modelVariantExists,
  parseModelKey,
} from "../ModelSelector";
import { BranchSelector } from "../create-task/branch-selector";
import {
  ErrorState,
  SelectField,
  TextField,
  useToast,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { Button } from "../common";
import { useShellHeaderActions } from "./shell-header-actions";

interface ImportableChatSession {
  id: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  model?: string;
}

function getPreferredModelKey(
  models: UseDashboardDataResult["models"],
  preferredModel: UseDashboardDataResult["lastModel"],
  fallbackModel: UseDashboardDataResult["lastModel"],
): string {
  for (const candidate of [preferredModel, fallbackModel]) {
    if (!candidate) {
      continue;
    }
    const variant = candidate.variant ?? "";
    if (!modelVariantExists(models, candidate.providerID, candidate.modelID, variant)) {
      continue;
    }
    const matchingModel = models.find(
      (model) =>
        model.connected
        && model.providerID === candidate.providerID
        && model.modelID === candidate.modelID,
    );
    if (!matchingModel) {
      continue;
    }
    return makeModelKey(candidate.providerID, candidate.modelID, variant);
  }

  const firstConnected = models.find((model) => model.connected);
  if (!firstConnected) {
    return "";
  }
  return makeModelKey(
    firstConnected.providerID,
    firstConnected.modelID,
    firstConnected.variants?.[0] ?? "",
  );
}

export function ComposeChatView({
  composeWorkspace,
  workspaces,
  workspacesLoading,
  workspaceError,
  dashboardData,
  navigateWithinShell,
  createChat,
  importExistingChat,
}: {
  composeWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  dashboardData: UseDashboardDataResult;
  navigateWithinShell: (route: WebAppRoute) => void;
  createChat: (request: CreateChatRequest) => Promise<Chat | null>;
  importExistingChat: (request: ImportExistingChatRequest) => Promise<Chat | null>;
}) {
  const { error: showError } = useToast();
  const {
    branches,
    branchesLoading,
    currentBranch,
    defaultBranch,
    handleWorkspaceChange,
    lastModel,
    models,
    modelsLoading,
    resetCreateModalState,
    setLastModel,
  } = dashboardData;
  const storedChatModel = useMemo(() => getStoredChatModelPreference(), []);
  const [name, setName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(composeWorkspace?.id ?? "");
  const [selectedModel, setSelectedModel] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [autoApprovePermissions, setAutoApprovePermissions] = useState(true);
  const [baseBranch, setBaseBranch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [importExistingSession, setImportExistingSession] = useState(false);
  const [importSessions, setImportSessions] = useState<ImportableChatSession[]>([]);
  const [importSessionsLoading, setImportSessionsLoading] = useState(false);
  const [selectedImportSessionId, setSelectedImportSessionId] = useState("");
  const loadedWorkspaceRef = useRef<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    loadedWorkspaceRef.current = null;
    setSelectedWorkspaceId(composeWorkspace?.id ?? "");
    setSelectedModel("");
  }, [composeWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace) {
      loadedWorkspaceRef.current = null;
      resetCreateModalState();
      setSelectedModel("");
      setBaseBranch("");
      return;
    }
    const workspaceKey = `${selectedWorkspace.id}:${selectedWorkspace.directory}`;
    if (loadedWorkspaceRef.current === workspaceKey) {
      return;
    }
    loadedWorkspaceRef.current = workspaceKey;
    setSelectedModel("");
    setBaseBranch("");
    handleWorkspaceChange(
      selectedWorkspace.id,
      selectedWorkspace.directory,
      selectedWorkspace.workspaceType,
    );
  }, [handleWorkspaceChange, resetCreateModalState, selectedWorkspace?.directory, selectedWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "git") {
      setBaseBranch("");
      return;
    }
    setBaseBranch((current) => current || defaultBranch || currentBranch);
  }, [currentBranch, defaultBranch, selectedWorkspace?.id, selectedWorkspace?.workspaceType]);

  useEffect(() => {
    if (!importExistingSession || !selectedWorkspace) {
      setImportSessions([]);
      setSelectedImportSessionId("");
      return;
    }

    const controller = new AbortController();
    void (async () => {
      setImportSessionsLoading(true);
      try {
        const sessions = await apiRequest<ImportableChatSession[]>(
          `/api/chats/importable-sessions?workspaceId=${encodeURIComponent(selectedWorkspace.id)}`,
          {
            signal: controller.signal,
            action: "List importable chat sessions",
            fallbackMessage: "Failed to list existing sessions",
          },
        );
        if (controller.signal.aborted) {
          return;
        }
        setImportSessions(sessions);
        setSelectedImportSessionId((current) => (
          current && sessions.some((session) => session.id === current)
            ? current
            : sessions[0]?.id ?? ""
        ));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setImportSessions([]);
        setSelectedImportSessionId("");
        showError(String(error));
      } finally {
        if (!controller.signal.aborted) {
          setImportSessionsLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [importExistingSession, selectedWorkspace?.id, showError]);

  useEffect(() => {
    if (importExistingSession) {
      setUseWorktree(false);
    }
  }, [importExistingSession]);

  useEffect(() => {
    if (selectedModel || models.length === 0) {
      return;
    }
    setSelectedModel(
      getPreferredModelKey(
        models,
        storedChatModel,
        lastModel,
      ),
    );
  }, [lastModel, models, selectedModel, storedChatModel]);

  async function handleSubmit(): Promise<void> {
    if (!selectedWorkspace) {
      showError("Select a workspace first");
      return;
    }
    const parsedModel = parseModelKey(effectiveSelectedModel);
    if (!parsedModel) {
      showError("Select a model first");
      return;
    }

    setIsSubmitting(true);
    try {
      if (importExistingSession) {
        const selectedImportSession = importSessions.find((session) => session.id === selectedImportSessionId);
        const selectedSessionId = selectedImportSessionId.trim();
        if (!selectedSessionId || !selectedImportSession) {
          showError("Select an existing session");
          return;
        }
        const chat = await importExistingChat({
          name: name.trim() || selectedImportSession?.title,
          workspaceId: selectedWorkspace.id,
          model: {
            providerID: parsedModel.providerID,
            modelID: parsedModel.modelID,
            variant: parsedModel.variant ?? "",
          },
          sessionId: selectedSessionId,
          cwd: selectedImportSession.cwd,
          autoApprovePermissions,
        });
        if (!chat) {
          showError("Failed to import chat");
          return;
        }
        setLastModel({
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant,
        });
        saveStoredChatModelPreference({
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant,
        });
        navigateWithinShell({ view: "chat", chatId: chat.config.id });
        return;
      }

      const chat = await createChat({
        name: name.trim(),
        workspaceId: selectedWorkspace.id,
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant ?? "",
        },
        useWorktree: selectedWorkspace.workspaceType === "git" ? useWorktree : false,
        autoApprovePermissions,
        ...(selectedWorkspace.workspaceType === "git"
          ? { baseBranch: baseBranch.trim() || currentBranch.trim() }
          : {}),
        quick: false,
      });
      if (!chat) {
        showError("Failed to create chat");
        return;
      }
      setLastModel({
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      });
      saveStoredChatModelPreference({
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      });
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleCancel = useCallback(() => {
    navigateWithinShell(
      composeWorkspace ? { view: "workspace", workspaceId: composeWorkspace.id } : { view: "home" },
    );
  }, [composeWorkspace, navigateWithinShell]);

  const modelOptions = models;
  const modelOptionsLoading = modelsLoading;
  const effectiveSelectedModel = selectedModel || (
    models.length > 0
      ? getPreferredModelKey(models, storedChatModel, lastModel)
      : ""
  );
  const canSubmit = !isSubmitting
    && (selectedWorkspace?.workspaceType !== "git" || !branchesLoading)
    && !modelOptionsLoading
    && !importSessionsLoading
    && Boolean(selectedWorkspace)
    && Boolean(effectiveSelectedModel)
    && (importExistingSession ? Boolean(selectedImportSessionId.trim()) : true);
  const headerActions = useMemo(() => (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={handleCancel} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        loading={isSubmitting}
      >
        {importExistingSession ? "Import chat" : "Create chat"}
      </Button>
    </>
  ), [canSubmit, handleCancel, handleSubmit, importExistingSession, isSubmitting]);
  useShellHeaderActions(headerActions);

  return (
    <>
      <div className="space-y-5">
          <TextField
            id="chat-name"
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Repository pairing session"
          />

        <div>
          <SelectField
            id="chat-workspace"
            label="Workspace"
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            disabled={Boolean(composeWorkspace) || workspacesLoading}
          >
            <option value="">
              {workspacesLoading ? "Loading workspaces..." : "Select a workspace"}
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
            ))}
          </SelectField>
          {workspaceError && (
            <ErrorState title="Unable to load workspaces" description={workspaceError} />
          )}
        </div>

        <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={importExistingSession}
                onChange={(event) => setImportExistingSession(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
              />
              <div className="flex-1">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Import existing session
                </span>
              </div>
            </label>

            {importExistingSession && (
              <div className="mt-4">
                <div>
                  <SelectField
                    id="import-session-select"
                    label="Existing sessions"
                    value={selectedImportSessionId}
                    onChange={(event) => setSelectedImportSessionId(event.target.value)}
                    disabled={importSessionsLoading || importSessions.length === 0}
                  >
                    <option value="">
                      {importSessionsLoading
                        ? "Loading sessions..."
                        : importSessions.length === 0 ? "No discoverable sessions" : "Select a session"}
                    </option>
                    {importSessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {(session.title || session.id)}{session.cwd ? ` - ${session.cwd}` : ""}
                      </option>
                    ))}
                  </SelectField>
                </div>
              </div>
            )}
          </div>

        <div>
          <label htmlFor="chat-model" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Model
          </label>
          <ModelSelector
            id="chat-model"
            value={effectiveSelectedModel}
            onChange={setSelectedModel}
            models={modelOptions}
            loading={modelOptionsLoading}
            showDisconnected
            variantDiscovery={selectedWorkspace ? {
              workspaceId: selectedWorkspace.id,
            } : undefined}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            emptyText="Select a workspace to load models"
          />
        </div>

        {selectedWorkspace?.workspaceType === "git" && (
          <BranchSelector
          selectedBranch={baseBranch}
          onBranchChange={setBaseBranch}
          branches={branches}
          branchesLoading={branchesLoading}
          defaultBranch={defaultBranch}
          currentBranch={currentBranch}
          disabled={importExistingSession}
          />
        )}

        {selectedWorkspace?.workspaceType === "git" && (
          <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={importExistingSession ? false : useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
              disabled={importExistingSession}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Use worktree
              </span>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Keep the chat session isolated in its own Clanky worktree when supported.
              </p>
            </div>
          </label>
        </div>
        )}

        {selectedWorkspace?.workspaceType === "directory" && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          This chat runs directly at the selected path without branches or worktrees.
        </p>
        )}

        <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={autoApprovePermissions}
              onChange={(event) => setAutoApprovePermissions(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Auto-approve permissions
              </span>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Let the provider continue automatically when it requests permission to run actions.
              </p>
            </div>
          </label>
        </div>
      </div>

    </>
  );
}
