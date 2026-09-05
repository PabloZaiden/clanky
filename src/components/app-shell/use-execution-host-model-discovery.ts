import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@/contracts";
import type { ExecutionHostDescriptor } from "@/shared";
import type { AgentProvider } from "@/shared/settings";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { apiRequest } from "../../lib/api-client";

interface ProviderAvailability {
  providerID: AgentProvider;
  available: boolean;
}

function executionHostApiPath(host: ExecutionHostDescriptor): string {
  const id = host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId;
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

function isAgentProvider(value: string): value is AgentProvider {
  return AGENT_PROVIDER_OPTIONS.some((option) => option.id === value);
}

export function useExecutionHostModelDiscovery(
  host: ExecutionHostDescriptor,
  directory: string,
  secondaryPreferredProvider?: string,
) {
  const preferredProvider = host.preferredModel?.providerID;
  const [provider, setProvider] = useState<AgentProvider>(
    preferredProvider && isAgentProvider(preferredProvider)
      ? preferredProvider
      : secondaryPreferredProvider && isAgentProvider(secondaryPreferredProvider)
        ? secondaryPreferredProvider
      : "copilot",
  );
  const [availableProviders, setAvailableProviders] = useState<AgentProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apiPath = useMemo(
    () => executionHostApiPath(host),
    [
      host.ref.kind,
      host.ref.kind === "ssh" ? host.ref.serverId : host.ref.nodeId,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    setProvidersLoading(true);
    setAvailableProviders([]);
    setModels([]);
    setError(null);
    void (async () => {
      try {
        const result = await apiRequest<{ providers: ProviderAvailability[] }>(
          `${apiPath}/chat-providers`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credentialToken: null }),
            signal: controller.signal,
            action: "Discover execution-host providers",
            fallbackMessage: "Failed to discover providers on this server",
          },
        );
        if (controller.signal.aborted) {
          return;
        }
        const nextProviders = result.providers
          .filter((candidate) => candidate.available && isAgentProvider(candidate.providerID))
          .map((candidate) => candidate.providerID);
        setAvailableProviders(nextProviders);
        setProvider((current) => {
          if (
            preferredProvider
            && isAgentProvider(preferredProvider)
            && nextProviders.includes(preferredProvider)
          ) {
            return preferredProvider;
          }
          if (
            secondaryPreferredProvider
            && isAgentProvider(secondaryPreferredProvider)
            && nextProviders.includes(secondaryPreferredProvider)
          ) {
            return secondaryPreferredProvider;
          }
          if (nextProviders.includes(current)) {
            return current;
          }
          return nextProviders[0] ?? "copilot";
        });
      } catch (discoveryError) {
        if (discoveryError instanceof DOMException && discoveryError.name === "AbortError") {
          return;
        }
        setError(String(discoveryError));
      } finally {
        if (!controller.signal.aborted) {
          setProvidersLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [apiPath, preferredProvider, secondaryPreferredProvider]);

  useEffect(() => {
    const resolvedDirectory = directory.trim();
    if (!resolvedDirectory || !availableProviders.includes(provider)) {
      setModels([]);
      setModelsLoading(false);
      return;
    }

    const controller = new AbortController();
    setModelsLoading(true);
    setModels([]);
    setError(null);
    void (async () => {
      try {
        const nextModels = await apiRequest<ModelInfo[]>(
          `${apiPath}/chat-models`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              credentialToken: null,
              providerID: provider,
              directory: resolvedDirectory,
            }),
            signal: controller.signal,
            action: "Discover execution-host models",
            fallbackMessage: "Failed to discover models on this server",
          },
        );
        if (!controller.signal.aborted) {
          setModels(nextModels);
        }
      } catch (discoveryError) {
        if (discoveryError instanceof DOMException && discoveryError.name === "AbortError") {
          return;
        }
        setError(String(discoveryError));
      } finally {
        if (!controller.signal.aborted) {
          setModelsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [apiPath, availableProviders, directory, provider]);

  const providerOptions = AGENT_PROVIDER_OPTIONS.filter((option) =>
    availableProviders.includes(option.id));

  return {
    provider,
    setProvider,
    providerOptions,
    providersLoading,
    models,
    modelsLoading,
    error,
  };
}
