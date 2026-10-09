import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Workspace } from "@/shared";
import type { CreateChatRequest } from "@/contracts";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
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
  useHeaderActions,
  useToast,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { Button } from "../common";

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
}: {
  composeWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  dashboardData: UseDashboardDataResult;
  navigateWithinShell: (route: WebAppRoute) => void;
  createChat: (request: CreateChatRequest) => Promise<Chat | null>;
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
  const [useChatNameAsBranch, setUseChatNameAsBranch] = useState(false);
  const [autoApprovePermissions, setAutoApprovePermissions] = useState(true);
  const [baseBranch, setBaseBranch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
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
    if (!selectedWorkspace) {
      setUseWorktree(false);
      return;
    }
    if (selectedWorkspace.workspaceType !== "git" || selectedWorkspace.allowWorktrees === false) {
      setUseWorktree(false);
      return;
    }
    setUseWorktree(true);
  }, [selectedWorkspace?.id]);

  const worktreesAllowed = selectedWorkspace?.workspaceType === "git"
    && selectedWorkspace.allowWorktrees !== false;
  const worktreeControlDisabled = !worktreesAllowed;

  useEffect(() => {
    if (!worktreesAllowed || !useWorktree) {
      setUseChatNameAsBranch(false);
    }
  }, [useWorktree, worktreesAllowed]);

  useEffect(() => {
    if (!worktreesAllowed) {
      setUseWorktree(false);
    }
  }, [selectedWorkspace?.id, worktreesAllowed]);

  useEffect(() => {
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "git") {
      setBaseBranch("");
      return;
    }
    setBaseBranch((current) => current || defaultBranch || currentBranch);
  }, [currentBranch, defaultBranch, selectedWorkspace?.id, selectedWorkspace?.workspaceType]);

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
      const chat = await createChat({
        name: name.trim(),
        workspaceId: selectedWorkspace.id,
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant ?? "",
        },
        useWorktree: worktreesAllowed ? useWorktree : false,
        ...(worktreesAllowed && useWorktree && useChatNameAsBranch
          ? { useChatNameAsBranch: true }
          : {}),
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
    && Boolean(selectedWorkspace)
    && Boolean(effectiveSelectedModel);
  const headerActions = useMemo(() => (
    <Button
      type="button"
      size="sm"
      onClick={() => void handleSubmit()}
      disabled={!canSubmit}
      loading={isSubmitting}
    >
      Create
    </Button>
  ), [canSubmit, handleSubmit, isSubmitting]);
  useHeaderActions({ primary: headerActions });

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
          />
        )}

        {selectedWorkspace?.workspaceType === "git" && (
          <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={worktreesAllowed ? useWorktree : false}
              onChange={(event) => setUseWorktree(event.target.checked)}
              disabled={worktreeControlDisabled}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className={`flex-1 ${worktreeControlDisabled ? "opacity-60" : ""}`}>
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

        {worktreesAllowed && useWorktree && (
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={useChatNameAsBranch}
            onChange={(event) => setUseChatNameAsBranch(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
          />
          <div className="flex-1">
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Use chat name as branch name
            </span>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Uses a Git-safe version of this name without the usual prefix or ID suffix.
            </p>
          </div>
        </label>
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
