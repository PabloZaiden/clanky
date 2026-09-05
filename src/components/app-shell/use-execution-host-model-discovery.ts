import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@/contracts";
import type { ExecutionHostDescriptor } from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import {
  DEFAULT_EXECUTION_AGENT_PROVIDER,
  isAgentProvider,
  type AgentProvider,
} from "@/shared/settings";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { apiRequest } from "../../lib/api-client";
import { isApiErrorCode } from "../../lib/api-error";

interface ProviderAvailability {
  providerID: AgentProvider;
  available: boolean;
}

function executionHostApiPath(host: ExecutionHostDescriptor): string {
  const id = getExecutionHostSourceId(host.ref);
  return `/api/execution-hosts/${host.ref.kind}/${encodeURIComponent(id)}`;
}

export function useExecutionHostModelDiscovery(
  host: ExecutionHostDescriptor,
  directory: string,
  secondaryPreferredProvider?: string,
  credentialToken: string | null = null,
  onCredentialRejected?: () => void,
) {
  const preferredProvider = host.preferredModel?.providerID;
  const [provider, setProvider] = useState<AgentProvider>(
    preferredProvider && isAgentProvider(preferredProvider)
      ? preferredProvider
      : secondaryPreferredProvider && isAgentProvider(secondaryPreferredProvider)
        ? secondaryPreferredProvider
        : DEFAULT_EXECUTION_AGENT_PROVIDER,
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
      getExecutionHostSourceId(host.ref),
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    setProvidersLoading(true);
    setAvailableProviders([]);
    setModels([]);
    setError(null);
    if (host.ref.kind === "ssh" && !credentialToken) {
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
            body: JSON.stringify({ credentialToken }),
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
          return nextProviders[0] ?? DEFAULT_EXECUTION_AGENT_PROVIDER;
        });
      } catch (discoveryError) {
        if (discoveryError instanceof DOMException && discoveryError.name === "AbortError") {
          return;
        }
        if (isApiErrorCode(discoveryError, "invalid_credential_token")) {
          onCredentialRejected?.();
        }
        setError(String(discoveryError));
      } finally {
        if (!controller.signal.aborted) {
          setProvidersLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [
    apiPath,
    credentialToken,
    host.ref.kind,
    onCredentialRejected,
    preferredProvider,
    secondaryPreferredProvider,
  ]);

  useEffect(() => {
    const resolvedDirectory = directory.trim();
    if (!resolvedDirectory || !availableProviders.includes(provider)) {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    if (host.ref.kind === "ssh" && !credentialToken) {
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
              credentialToken,
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
        if (isApiErrorCode(discoveryError, "invalid_credential_token")) {
          onCredentialRejected?.();
        }
        setError(String(discoveryError));
      } finally {
        if (!controller.signal.aborted) {
          setModelsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [
    apiPath,
    availableProviders,
    credentialToken,
    directory,
    host.ref.kind,
    onCredentialRejected,
    provider,
  ]);

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
