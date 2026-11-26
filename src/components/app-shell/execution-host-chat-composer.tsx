import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ErrorState,
  SelectField,
  TextField,
  useHeaderActions,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { Chat, ExecutionHostDescriptor } from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import { createAgentSettings, getHarnessAdapterForProvider, isAgentProvider } from "@/shared/settings";
import type {
  CreateExecutionHostChatRequest,
  ExecutionHostWorkingDirectory,
} from "@/contracts";
import { apiRequest } from "../../lib/api-client";
import {
  getAvailableModelKey,
  ModelSelector,
  parseModelKey,
} from "../ModelSelector";
import { getMostRecentChat } from "./shell-types";
import { useExecutionHostModelDiscovery } from "./use-execution-host-model-discovery";
import type { UseChatsResult } from "../../hooks/useChats";

function executionHostApiPath(host: ExecutionHostDescriptor): string {
  const id = getExecutionHostSourceId(host.ref);
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function ExecutionHostChatComposer({
  host,
  chats,
  onCreateChat,
  navigateWithinShell,
}: {
  host: ExecutionHostDescriptor;
  chats: readonly Chat[];
  onCreateChat: UseChatsResult["createExecutionHostChat"];
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  const apiPath = useMemo(() => executionHostApiPath(host), [host.ref]);
  const recentChat = useMemo(() => getMostRecentChat(chats, (chat) =>
    chat.config.source?.kind === "execution_host"
    && chat.config.source.executionHost.targetKey === host.targetKey), [chats, host.targetKey]);
  const recentSource = recentChat?.config.source;
  const recentAdapter = recentSource?.kind === "execution_host" ? recentSource.adapter : null;
  const { providerID, modelID, variant = "" } = recentChat?.config.model ?? {};
  const recentSelection = useMemo(() => {
    if (!providerID || !modelID) return undefined;
    const provider = recentAdapter ? createAgentSettings(recentAdapter).provider : providerID;
    return isAgentProvider(provider) ? { provider, model: { providerID, modelID, variant } } : undefined;
  }, [modelID, providerID, recentAdapter, variant]);
  const [name, setName] = useState("");
  const [startWithPlan, setStartWithPlan] = useState(false);
  const [directory, setDirectory] = useState(host.repositoriesBasePath ?? "");
  const [directoryLoading, setDirectoryLoading] = useState(
    host.repositoriesBasePath === null,
  );
  const [discoveryDirectory, setDiscoveryDirectory] = useState(
    host.repositoriesBasePath ?? "",
  );
  const [manualModel, setManualModel] = useState<{
    key: string;
    recent: typeof recentSelection;
  }>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = manualModel ? manualModel.recent : recentSelection;
  const discovery = useExecutionHostModelDiscovery(host, discoveryDirectory, recent);
  const preferred = host.preferredModel;
  // The host stores a harness provider; its catalog can use a model provider ID.
  const configuredModel = preferred?.providerID === discovery.provider
    ? discovery.models.find((model) => model.connected && model.modelID === preferred.modelID)
    : undefined;
  const manualSelection = manualModel ? parseModelKey(manualModel.key) : null;
  const selectedModel = manualModel?.key === "" ? "" :
    (manualSelection && getAvailableModelKey(discovery.models, manualSelection))
      || (recent?.provider === discovery.provider && getAvailableModelKey(discovery.models, recent.model))
      || (preferred && configuredModel && getAvailableModelKey(discovery.models, {
        ...preferred, providerID: configuredModel.providerID,
      }))
      || getAvailableModelKey(discovery.models);

  useEffect(() => {
    const controller = new AbortController();
    setDirectory(host.repositoriesBasePath ?? "");
    setDiscoveryDirectory(host.repositoriesBasePath ?? "");
    setDirectoryLoading(host.repositoriesBasePath === null);
    setManualModel(undefined);
    setError(null);
    void (async () => {
      try {
        const resolved = await apiRequest<ExecutionHostWorkingDirectory>(
          `${apiPath}/working-directory`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal: controller.signal,
            action: "Resolve execution-host working directory",
            fallbackMessage: "Failed to resolve the server working directory",
          },
        );
        if (!controller.signal.aborted) {
          setDirectory(resolved.directory);
          setDiscoveryDirectory(resolved.directory);
        }
      } catch (directoryError) {
        if (directoryError instanceof DOMException && directoryError.name === "AbortError") {
          return;
        }
        setError(String(directoryError));
      } finally {
        if (!controller.signal.aborted) {
          setDirectoryLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [
    apiPath,
    host.repositoriesBasePath,
  ]);

  const handleSubmit = useCallback(async () => {
    const model = parseModelKey(selectedModel);
    if (
      !directory.trim()
      || !model
      || !discovery.models.some((entry) => entry.connected
        && entry.providerID === model.providerID && entry.modelID === model.modelID)
    ) {
      setError("Choose a directory and model before creating the chat.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const request: CreateExecutionHostChatRequest = {
        name: name.trim() || `${host.name} chat`,
        adapter: getHarnessAdapterForProvider(discovery.provider),
        directory: directory.trim(),
        ...(startWithPlan ? { startWithPlan: true } : {}),
        model,
      };
      const chat = await onCreateChat(host.ref, request);
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [
    directory,
    discovery.models,
    discovery.provider,
    host.name,
    host.ref,
    name,
    navigateWithinShell,
    onCreateChat,
    selectedModel,
    startWithPlan,
  ]);

  const canSubmit = !submitting
    && !directoryLoading
    && !discovery.providersLoading
    && !discovery.modelsLoading
    && Boolean(directory.trim())
    && Boolean(selectedModel);
  const headerActions = useMemo(() => [{
    id: "create-host-chat",
    label: "Create",
    systemImage: "plus.bubble",
    onAction: () => void handleSubmit(),
    disabled: !canSubmit,
    loading: submitting,
  }], [canSubmit, handleSubmit, submitting]);
  useHeaderActions({ primary: headerActions });

  return (
    <>
      <div className="space-y-5">
        {error || discovery.error ? (
          <ErrorState description={error ?? discovery.error ?? ""} />
        ) : null}
        <label className="flex items-center gap-3 text-sm font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={startWithPlan}
            onChange={(event) => setStartWithPlan(event.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700"
          />
          Start with a plan
        </label>
        <TextField
          id="execution-host-chat-name"
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={`${host.name} chat`}
        />
        <TextField
          id="execution-host-chat-directory"
          label="Directory"
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          onBlur={() => {
            if (directory.trim()) {
              setDiscoveryDirectory(directory.trim());
            }
          }}
          disabled={directoryLoading}
          className="font-mono"
        />
        <SelectField
          id="execution-host-chat-provider"
          label="Provider"
          value={discovery.provider}
          onChange={(event) => {
            const provider = event.target.value;
            if (isAgentProvider(provider)) {
              setManualModel(undefined);
              discovery.setProvider(provider);
            }
          }}
          disabled={
            discovery.providersLoading || discovery.providerOptions.length === 0
          }
        >
          {discovery.providerOptions.length === 0 ? (
            <option value="">
              {discovery.providersLoading
                ? "Loading providers..."
                : "No providers available"}
            </option>
          ) : discovery.providerOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <div>
          <label
            htmlFor="execution-host-chat-model"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Model
          </label>
          <ModelSelector
            id="execution-host-chat-model"
            value={selectedModel}
            onChange={(key) => setManualModel({ key, recent })}
            models={discovery.models}
            loading={discovery.modelsLoading}
            showDisconnected
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            emptyText="Choose an available provider and directory"
          />
        </div>
      </div>
    </>
  );
}
