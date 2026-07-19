import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicWorkspace } from "@/shared";
import type { ModelInfo } from "@/contracts";
import type { QuickChatSettings } from "@/shared/preferences";
import { createClientLogger } from "../../lib/client-logger";
import { fetchQuickChatModels } from "../../hooks/quick-chat-api";
import {
  makeModelKey,
  ModelSelector,
  modelVariantExists,
  parseModelKey,
} from "../ModelSelector";
import { SettingsError } from "./settings-row-controls";

const log = createClientLogger("QuickChatModelRowContent");

function getModelKey(settings: QuickChatSettings): string {
  if (!settings.model) {
    return "";
  }
  return makeModelKey(settings.model.providerID, settings.model.modelID, settings.model.variant);
}

export function QuickChatModelRowContent({
  workspace,
  settings,
  loading,
  saving,
  onUpdate,
}: {
  workspace: PublicWorkspace | null;
  settings: QuickChatSettings;
  loading: boolean;
  saving: boolean;
  onUpdate: (settings: QuickChatSettings) => Promise<QuickChatSettings | null>;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

    if (!workspace) {
      setModels([]);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    const selectedWorkspace = workspace;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    async function fetchModels(): Promise<void> {
      setModelsLoading(true);
      setModelsError(null);
      try {
        const nextModels = await fetchQuickChatModels(selectedWorkspace, { signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        setModels(nextModels);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }
        log.warn("Failed to load quick chat models", {
          workspaceId: selectedWorkspace.id,
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
  }, [workspace?.directory, workspace?.id]);

  const modelOptions = useMemo(() => ({
    showDisconnected: true,
    variantDiscovery: workspace ? { workspaceId: workspace.id } : undefined,
    placeholder: "Select a quick chat model...",
    emptyText: workspace ? "No models available" : "Select a workspace to load models",
    additionalOptions: savedModelUnavailable
      ? [{
          value: selectedModelKey,
          label: "Saved model is unavailable",
          disabled: true,
        }]
      : [],
  }), [savedModelUnavailable, selectedModelKey, workspace]);

  async function handleModelChange(modelKey: string): Promise<void> {
    const parsedModel = parseModelKey(modelKey);
    if (!workspace || !parsedModel) {
      await onUpdate({
        workspaceId: workspace?.id ?? "",
        model: null,
        useWorktree: settings.useWorktree,
      });
      return;
    }

    await onUpdate({
      workspaceId: workspace.id,
      model: {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      },
      useWorktree: settings.useWorktree,
    });
  }

  return (
    <div className="space-y-2">
      <ModelSelector
        id="quick-chat-model"
        ariaLabel="Quick Chat model"
        value={selectedModelKey}
        onChange={(modelKey) => void handleModelChange(modelKey)}
        models={models}
        loading={modelsLoading}
        disabled={loading || saving || !workspace}
        className={SELECT_CLASS_NAME}
        {...modelOptions}
      />
      {modelsError ? <SettingsError>{modelsError}</SettingsError> : null}
      {savedModelUnavailable ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          The saved quick chat model is not available for this workspace. Select another model before using quick chat.
        </p>
      ) : null}
    </div>
  );
}

const SELECT_CLASS_NAME = "block w-full max-w-xl rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600";
