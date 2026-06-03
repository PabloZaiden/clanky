import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, PublicWorkspace } from "../../types";
import type { QuickChatSettings } from "../../types/preferences";
import { DEFAULT_QUICK_CHAT_SETTINGS } from "../../types/preferences";
import { createLogger } from "../../lib/logger";
import { fetchQuickChatModels } from "../../hooks/quick-chat-api";
import {
  makeModelKey,
  ModelSelector,
  modelVariantExists,
  parseModelKey,
} from "../ModelSelector";
import { Button } from "../common";

const log = createLogger("QuickChatSettingsSection");

function getModelKey(settings: QuickChatSettings): string {
  if (!settings.model) {
    return "";
  }
  return makeModelKey(settings.model.providerID, settings.model.modelID, settings.model.variant);
}

export function QuickChatSettingsSection({
  workspaces,
  workspacesLoading,
  settings,
  loading,
  saving,
  error,
  onUpdate,
}: {
  workspaces: PublicWorkspace[];
  workspacesLoading: boolean;
  settings: QuickChatSettings;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onUpdate: (settings: QuickChatSettings) => Promise<QuickChatSettings | null>;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === settings.workspaceId) ?? null,
    [settings.workspaceId, workspaces],
  );
  const selectedModelKey = getModelKey(settings);
  const savedModelUnavailable = Boolean(
    selectedModelKey
    && models.length > 0
    && settings.model
    && !modelVariantExists(
      models,
      settings.model.providerID,
      settings.model.modelID,
      settings.model.variant,
    ),
  );

  useEffect(() => {
    abortControllerRef.current?.abort();

    if (!selectedWorkspace) {
      setModels([]);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    const workspace = selectedWorkspace;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    async function fetchModels(): Promise<void> {
      setModelsLoading(true);
      setModelsError(null);
      try {
        const nextModels = await fetchQuickChatModels(workspace, { signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        setModels(nextModels);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }
        log.warn("Failed to load quick chat models", {
          workspaceId: workspace.id,
          error: String(fetchError),
        });
        setModels([]);
        setModelsError(String(fetchError));
      } finally {
        if (!controller.signal.aborted) {
          setModelsLoading(false);
        }
      }
    }

    void fetchModels();
    return () => controller.abort();
  }, [selectedWorkspace?.directory, selectedWorkspace?.id]);

  async function handleWorkspaceChange(workspaceId: string): Promise<void> {
    await onUpdate({
      workspaceId,
      model: null,
      useWorktree: settings.useWorktree,
    });
  }

  async function handleModelChange(modelKey: string): Promise<void> {
    const parsedModel = parseModelKey(modelKey);
    if (!selectedWorkspace || !parsedModel) {
      await onUpdate({
        workspaceId: selectedWorkspace?.id ?? "",
        model: null,
        useWorktree: settings.useWorktree,
      });
      return;
    }

    await onUpdate({
      workspaceId: selectedWorkspace.id,
      model: {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      },
      useWorktree: settings.useWorktree,
    });
  }

  async function handleUseWorktreeChange(useWorktree: boolean): Promise<void> {
    await onUpdate({
      workspaceId: settings.workspaceId,
      model: settings.model,
      useWorktree,
    });
  }

  return (
    <div>
      <h3 className="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">
        Quick Chat
      </h3>
      <div className="space-y-4 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <div>
          <label htmlFor="quick-chat-workspace" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Workspace
          </label>
          <select
            id="quick-chat-workspace"
            value={settings.workspaceId}
            onChange={(event) => void handleWorkspaceChange(event.target.value)}
            disabled={loading || saving || workspacesLoading}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
          >
            <option value="">
              {workspacesLoading ? "Loading workspaces..." : "No quick chat workspace"}
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="quick-chat-model" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Model
          </label>
          <ModelSelector
            id="quick-chat-model"
            value={selectedModelKey}
            onChange={(modelKey) => void handleModelChange(modelKey)}
            models={models}
            loading={modelsLoading}
            disabled={loading || saving || !selectedWorkspace}
            showDisconnected
            placeholder="Select a quick chat model..."
            emptyText={selectedWorkspace ? "No models available" : "Select a workspace to load models"}
            additionalOptions={savedModelUnavailable
              ? [{
                  value: selectedModelKey,
                  label: "Saved model is unavailable",
                  disabled: true,
                }]
              : []}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
          />
          {modelsError && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{modelsError}</p>
          )}
          {savedModelUnavailable && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              The saved quick chat model is not available for this workspace. Select another model before using quick chat.
            </p>
          )}
        </div>

        <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={settings.useWorktree}
            onChange={(event) => void handleUseWorktreeChange(event.target.checked)}
            disabled={loading || saving}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:focus:ring-gray-600"
          />
          <span>
            <span className="block font-medium text-gray-700 dark:text-gray-300">
              Use worktrees for quick chats
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              Create quick chats in a separate git worktree when enabled.
            </span>
          </span>
        </label>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || saving || (!settings.workspaceId && !settings.model)}
            onClick={() => void onUpdate(DEFAULT_QUICK_CHAT_SETTINGS)}
          >
            Clear
          </Button>
        </div>

        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}
