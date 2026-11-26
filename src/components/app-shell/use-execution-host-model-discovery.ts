import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@/contracts";
import type { ExecutionHostDescriptor, ModelConfig } from "@/shared";
import {
  getExecutionHostAgentProvider,
  getExecutionHostSourceId,
  supportsExecutionHostCapability,
} from "@/shared";
import {
  isAgentProvider,
  type AgentProvider,
} from "@/shared/settings";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { apiRequest } from "../../lib/api-client";
import { getAvailableModelKey } from "../ModelSelector";

interface ProviderAvailability {
  providerID: AgentProvider;
  available: boolean;
}

interface RecentModelSelection {
  provider: AgentProvider;
  model: ModelConfig;
}

const EMPTY_MODELS: ModelInfo[] = [];

function executionHostApiPath(host: ExecutionHostDescriptor): string {
  const id = getExecutionHostSourceId(host.ref);
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function useExecutionHostModelDiscovery(
  host: ExecutionHostDescriptor,
  directory: string,
  recent?: RecentModelSelection,
) {
  const enabled = supportsExecutionHostCapability(host.capabilities, "commandExecution");
  const [providerSelection, setProvider] = useState<AgentProvider | null>(null);
  const [availableProviders, setAvailableProviders] = useState<AgentProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(enabled);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const apiPath = useMemo(
    () => executionHostApiPath(host),
    [
      host.ref.kind,
      getExecutionHostSourceId(host.ref),
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    setProvidersLoading(true);
    setAvailableProviders([]);
    setProvider(null);
    setProvidersError(null);
    if (!enabled) {
      setProvidersLoading(false);
      return;
    }
    void (async () => {
      try {
        const result = await apiRequest<{ providers: ProviderAvailability[] }>(
          `${apiPath}/chat-providers`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal: controller.signal,
            action: "Discover execution-host providers",
            fallbackMessage: "Failed to discover providers on this server",
          },
        );
        if (controller.signal.aborted) {
          return;
        }
        setAvailableProviders(result.providers
          .filter((candidate) => candidate.available && isAgentProvider(candidate.providerID))
          .map((candidate) => candidate.providerID));
      } catch (discoveryError) {
        if (!controller.signal.aborted) {
          setProvidersError(String(discoveryError));
        }
      } finally {
        if (!controller.signal.aborted) {
          setProvidersLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [apiPath, enabled]);

  const configuredProvider = getExecutionHostAgentProvider(host);
  const defaultProvider = availableProviders.includes(configuredProvider)
    ? configuredProvider : availableProviders[0] ?? configuredProvider;
  const manualProvider = providerSelection && availableProviders.includes(providerSelection)
    ? providerSelection : null;
  const recentAvailable = recent && availableProviders.includes(recent.provider) ? recent : undefined;
  const requestedProvider = manualProvider ?? recentAvailable?.provider ?? defaultProvider;
  const recentModel = !manualProvider && recentAvailable && requestedProvider !== defaultProvider
    ? recentAvailable.model : undefined;
  const resolvedDirectory = directory.trim();
  const canLoadModels = enabled && resolvedDirectory !== "" && availableProviders.includes(requestedProvider);
  const request = useMemo(() => canLoadModels ? {
    apiPath,
    directory: resolvedDirectory,
    provider: requestedProvider,
    fallback: recentModel ? { provider: defaultProvider, recentModel } : undefined,
  } : null, [apiPath, canLoadModels, defaultProvider, recentModel, requestedProvider, resolvedDirectory]);
  const [catalog, setCatalog] = useState<{
    request: NonNullable<typeof request>;
    provider: AgentProvider;
    models: ModelInfo[];
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const fetchModels = (providerID: AgentProvider): Promise<ModelInfo[]> =>
      apiRequest<ModelInfo[]>(`${request.apiPath}/chat-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerID, directory: request.directory }),
        signal: controller.signal,
        action: "Discover execution-host models",
        fallbackMessage: "Failed to discover models on this server",
      });
    void (async () => {
      let provider = request.provider;
      try {
        let models = await fetchModels(provider);
        if (controller.signal.aborted) return;
        if (request.fallback && !getAvailableModelKey(models, request.fallback.recentModel)) {
          provider = request.fallback.provider;
          models = await fetchModels(provider);
        }
        if (!controller.signal.aborted) {
          setCatalog({ request, provider, models, error: null });
        }
      } catch (discoveryError) {
        if (!controller.signal.aborted) {
          setCatalog({ request, provider, models: EMPTY_MODELS, error: String(discoveryError) });
        }
      }
    })();
    return () => controller.abort();
  }, [request]);

  const activeCatalog = catalog?.request === request ? catalog : null;
  const providerOptions = AGENT_PROVIDER_OPTIONS.filter((option) =>
    availableProviders.includes(option.id));

  return {
    provider: activeCatalog?.provider ?? requestedProvider,
    setProvider,
    providerOptions,
    providersLoading,
    models: activeCatalog?.models ?? EMPTY_MODELS,
    modelsLoading: request !== null && activeCatalog === null,
    error: providersError ?? activeCatalog?.error ?? null,
  };
}
