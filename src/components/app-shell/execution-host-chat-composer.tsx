import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ErrorState,
  SelectField,
  TextField,
  useHeaderActions,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type {
  Chat,
  ExecutionHostDescriptor,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import type {
  CreateExecutionHostChatRequest,
  ExecutionHostWorkingDirectory,
} from "@/contracts";
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
import { useExecutionHostModelDiscovery } from "./use-execution-host-model-discovery";

function executionHostApiPath(host: ExecutionHostDescriptor): string {
  const id = getExecutionHostSourceId(host.ref);
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function ExecutionHostChatComposer({
  host,
  navigateWithinShell,
}: {
  host: ExecutionHostDescriptor;
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  const apiPath = useMemo(() => executionHostApiPath(host), [host.ref]);
  const storedModel = useMemo(() => getStoredChatModelPreference(), []);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(host.repositoriesBasePath ?? "");
  const [directoryLoading, setDirectoryLoading] = useState(
    host.repositoriesBasePath === null,
  );
  const [discoveryDirectory, setDiscoveryDirectory] = useState(
    host.repositoriesBasePath ?? "",
  );
  const [selectedModel, setSelectedModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discovery = useExecutionHostModelDiscovery(
    host,
    discoveryDirectory,
    storedModel?.providerID,
  );

  useEffect(() => {
    const controller = new AbortController();
    setDirectory(host.repositoriesBasePath ?? "");
    setDiscoveryDirectory(host.repositoriesBasePath ?? "");
    setDirectoryLoading(host.repositoriesBasePath === null);
    setSelectedModel("");
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

  useEffect(() => {
    const candidates = [host.preferredModel, storedModel];
    for (const candidate of candidates) {
      if (
        candidate
        && candidate.providerID === discovery.provider
        && discovery.models.some((model) =>
          model.connected
          && model.providerID === candidate.providerID
          && model.modelID === candidate.modelID)
        && modelVariantExists(
          discovery.models,
          candidate.providerID,
          candidate.modelID,
          candidate.variant,
        )
      ) {
        setSelectedModel(makeModelKey(
          candidate.providerID,
          candidate.modelID,
          candidate.variant,
        ));
        return;
      }
    }
    const firstConnected = discovery.models.find((model) => model.connected);
    setSelectedModel(firstConnected
      ? makeModelKey(
        firstConnected.providerID,
        firstConnected.modelID,
        firstConnected.variants?.[0] ?? "",
      )
      : "");
  }, [discovery.models, discovery.provider, host.preferredModel, storedModel]);

  const handleSubmit = useCallback(async () => {
    const model = parseModelKey(selectedModel);
    if (
      !directory.trim()
      || !model
      || model.providerID !== discovery.provider
    ) {
      setError("Choose a directory and model before creating the chat.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const request: CreateExecutionHostChatRequest = {
        name: name.trim() || `${host.name} chat`,
        directory: directory.trim(),
        model: {
          providerID: discovery.provider,
          modelID: model.modelID,
          variant: model.variant,
        },
      };
      const chat = await apiRequest<Chat>(`${apiPath}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create execution-host chat",
        fallbackMessage: "Failed to create chat",
      });
      saveStoredChatModelPreference(model);
      navigateWithinShell({ view: "chat", chatId: chat.config.id });
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [
    apiPath,
    directory,
    discovery.provider,
    host.name,
    name,
    navigateWithinShell,
    selectedModel,
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
          onChange={(event) =>
            discovery.setProvider(event.target.value as typeof discovery.provider)}
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
            onChange={setSelectedModel}
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
