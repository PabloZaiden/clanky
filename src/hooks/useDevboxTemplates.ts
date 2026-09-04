import { useCallback, useEffect, useRef, useState } from "react";
import type { DevboxTemplateSummary, ExecutionHostRef } from "@/shared";
import { listDevboxTemplatesApi } from "./sshServerActions";
import { apiRequest } from "../lib/api-client";

export interface UseDevboxTemplatesOptions {
  serverId: string;
  password?: string;
  executionHost?: ExecutionHostRef;
}

export interface UseDevboxTemplatesResult {
  templates: DevboxTemplateSummary[];
  templatesLoading: boolean;
  templatesError: string | null;
  refreshTemplates: (passwordOverride?: string) => Promise<DevboxTemplateSummary[]>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function useDevboxTemplates({
  serverId,
  password,
  executionHost,
}: UseDevboxTemplatesOptions): UseDevboxTemplatesResult {
  const [templates, setTemplates] = useState<DevboxTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const latestPasswordRef = useRef(password);
  const activeControllerRef = useRef<AbortController | null>(null);
  const latestRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    latestPasswordRef.current = password;
  }, [password]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
    };
  }, []);

  const refreshTemplates = useCallback(async (
    passwordOverride?: string,
  ): Promise<DevboxTemplateSummary[]> => {
    const trimmedServerId = serverId.trim();
    activeControllerRef.current?.abort();

    if (!executionHost && !trimmedServerId) {
      latestRequestIdRef.current += 1;
      activeControllerRef.current = null;
      if (mountedRef.current) {
        setTemplates([]);
        setTemplatesError(null);
        setTemplatesLoading(false);
      }
      return [];
    }

    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    const controller = new AbortController();
    activeControllerRef.current = controller;

    if (mountedRef.current) {
      setTemplatesLoading(true);
      setTemplatesError(null);
    }

    try {
      const nextTemplates = executionHost
        ? await apiRequest<DevboxTemplateSummary[]>(
            `/api/execution-hosts/${executionHost.kind}/${encodeURIComponent(
              executionHost.kind === "ssh" ? executionHost.serverId : executionHost.nodeId,
            )}/devbox-templates`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ credentialToken: null }),
              signal: controller.signal,
              action: "Load Devbox templates",
              fallbackMessage: "Failed to load Devbox templates",
            },
          )
        : await listDevboxTemplatesApi({
            serverId: trimmedServerId,
            password: passwordOverride ?? latestPasswordRef.current,
            signal: controller.signal,
          });
      if (
        !mountedRef.current
        || requestId !== latestRequestIdRef.current
        || controller.signal.aborted
      ) {
        return [];
      }
      setTemplates(nextTemplates);
      setTemplatesError(null);
      return nextTemplates;
    } catch (error) {
      if (
        isAbortError(error)
        || !mountedRef.current
        || requestId !== latestRequestIdRef.current
      ) {
        return [];
      }
      setTemplates([]);
      setTemplatesError(error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      if (
        mountedRef.current
        && requestId === latestRequestIdRef.current
        && activeControllerRef.current === controller
      ) {
        setTemplatesLoading(false);
      }
    }
  }, [executionHost, serverId]);

  useEffect(() => {
    if (!executionHost && !serverId.trim()) {
      setTemplates([]);
      setTemplatesError(null);
      setTemplatesLoading(false);
      return;
    }

    void refreshTemplates();
  }, [executionHost, serverId, refreshTemplates]);

  return {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  };
}
