import { useCallback, useEffect, useRef, useState } from "react";
import type { DevboxTemplateSummary, ExecutionHostRef } from "@/shared";
import { listExecutionHostDevboxTemplatesApi } from "./executionHostActions";
import { isAbortError } from "../lib/request-lifecycle";

export interface UseDevboxTemplatesOptions {
  executionHost: ExecutionHostRef | null;
}

export interface UseDevboxTemplatesResult {
  templates: DevboxTemplateSummary[];
  templatesLoading: boolean;
  templatesError: string | null;
  refreshTemplates: () => Promise<DevboxTemplateSummary[]>;
}

export function useDevboxTemplates({
  executionHost,
}: UseDevboxTemplatesOptions): UseDevboxTemplatesResult {
  const [templates, setTemplates] = useState<DevboxTemplateSummary[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const latestRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
    };
  }, []);

  const refreshTemplates = useCallback(async (): Promise<DevboxTemplateSummary[]> => {
    activeControllerRef.current?.abort();

    if (!executionHost) {
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
      const nextTemplates = await listExecutionHostDevboxTemplatesApi({
        executionHost,
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
  }, [executionHost]);

  useEffect(() => {
    if (!executionHost) {
      setTemplates([]);
      setTemplatesError(null);
      setTemplatesLoading(false);
      return;
    }

    void refreshTemplates();
  }, [executionHost, refreshTemplates]);

  return {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  };
}
