import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "../../types";
import type { CreateChatRequest } from "../../types/api";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { useToast } from "../../hooks";
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
import { BranchSelector } from "../create-loop/branch-selector";
import { Button } from "../common";
import { ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";

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
  shellHeaderOffsetClassName,
  navigateWithinShell,
  createChat,
}: {
  composeWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  dashboardData: UseDashboardDataResult;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  createChat: (request: CreateChatRequest) => Promise<import("../../types").Chat | null>;
}) {
  const toast = useToast();
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
  const storedChatModelRef = useRef(getStoredChatModelPreference());
  const [name, setName] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(composeWorkspace?.id ?? "");
  const [selectedModel, setSelectedModel] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [baseBranch, setBaseBranch] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (!selectedWorkspace) {
      resetCreateModalState();
      setSelectedModel("");
      setBaseBranch("");
      return;
    }
    setSelectedModel("");
    setBaseBranch("");
    handleWorkspaceChange(selectedWorkspace.id, selectedWorkspace.directory);
  }, [handleWorkspaceChange, resetCreateModalState, selectedWorkspace?.directory, selectedWorkspace?.id]);

  useEffect(() => {
    if (!selectedWorkspace) {
      return;
    }
    setBaseBranch((current) => current || defaultBranch || currentBranch);
  }, [currentBranch, defaultBranch, selectedWorkspace?.id]);

  useEffect(() => {
    if (selectedModel || models.length === 0) {
      return;
    }
    setSelectedModel(
      getPreferredModelKey(
        models,
        storedChatModelRef.current,
        lastModel,
      ),
    );
  }, [lastModel, models, selectedModel]);

  async function handleSubmit(): Promise<void> {
    if (!selectedWorkspace) {
      toast.error("Select a workspace first");
      return;
    }
    const parsedModel = parseModelKey(selectedModel);
    if (!parsedModel) {
      toast.error("Select a model first");
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
        useWorktree,
        baseBranch: baseBranch.trim() || currentBranch.trim(),
      });
      if (!chat) {
        toast.error("Failed to create chat");
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

  const handleCancel = () =>
    navigateWithinShell(
      composeWorkspace ? { view: "workspace", workspaceId: composeWorkspace.id } : { view: "home" },
    );

  return (
    <ShellPanel
      eyebrow="Chat"
      title={composeWorkspace ? `Start a new chat in ${composeWorkspace.name}` : "Start a new chat"}
      description={composeWorkspace?.directory}
      descriptionClassName="hidden font-mono sm:inline"
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      actions={(
        <>
          <Button type="button" variant="ghost" size="sm" onClick={handleCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={
              isSubmitting
              || branchesLoading
              || modelsLoading
              || !selectedWorkspace
              || !selectedModel
              || name.trim().length === 0
            }
            loading={isSubmitting}
          >
            Create chat
          </Button>
        </>
      )}
    >
      <div className="space-y-5">
        <div>
          <label htmlFor="chat-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Name
          </label>
          <input
            id="chat-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Repository pairing session"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
          />
        </div>

        <div>
          <label htmlFor="chat-workspace" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Workspace
          </label>
          <select
            id="chat-workspace"
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            disabled={Boolean(composeWorkspace) || workspacesLoading}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-60"
          >
            <option value="">
              {workspacesLoading ? "Loading workspaces..." : "Select a workspace"}
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          {workspaceError && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{workspaceError}</p>
          )}
        </div>

        <div>
          <label htmlFor="chat-model" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Model
          </label>
          <ModelSelector
            id="chat-model"
            value={selectedModel}
            onChange={setSelectedModel}
            models={models}
            loading={modelsLoading}
            showDisconnected
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            emptyText="Select a workspace to load models"
          />
        </div>

        <BranchSelector
          selectedBranch={baseBranch}
          onBranchChange={setBaseBranch}
          branches={branches}
          branchesLoading={branchesLoading}
          defaultBranch={defaultBranch}
          currentBranch={currentBranch}
        />

        <div>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Use worktree
              </span>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Keep the chat session isolated in its own Ralph worktree when supported.
              </p>
            </div>
          </label>
        </div>
      </div>
    </ShellPanel>
  );
}
