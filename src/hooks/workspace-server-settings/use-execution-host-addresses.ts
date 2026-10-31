import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionHostRef } from "@/shared";
import {
  getExecutionHostSourceId,
} from "@/shared/execution-host";
import { apiRequest } from "../../lib/api-client";
import { isAbortError } from "../../lib/request-lifecycle";

export function useExecutionHostAddresses(
  executionHost: ExecutionHostRef | null,
): {
  addresses: string[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [addresses, setAddresses] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const host = executionHost;
    if (!host) {
      setAddresses([]);
      setError(null);
      setLoading(false);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    setAddresses([]);
    setLoading(true);
    setError(null);

    try {
      const response = await apiRequest<{ addresses: string[] }>(
        `/api/execution-hosts/${encodeURIComponent(host.kind)}/${encodeURIComponent(
          getExecutionHostSourceId(host),
        )}/addresses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: controller.signal,
          action: "Discover execution-host addresses",
          fallbackMessage: "Failed to discover execution-host addresses",
        },
      );
      if (
        controller.signal.aborted
        || !mountedRef.current
        || requestId !== requestIdRef.current
      ) {
        return;
      }
      setAddresses(response.addresses);
    } catch (nextError) {
      if (
        controller.signal.aborted
        || !mountedRef.current
        || requestId !== requestIdRef.current
        || isAbortError(nextError)
      ) {
        return;
      }
      setAddresses([]);
      setError(String(nextError));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      if (
        !controller.signal.aborted
        && mountedRef.current
        && requestId === requestIdRef.current
      ) {
        setLoading(false);
      }
    }
  }, [executionHost]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [refresh]);

  return { addresses, loading, error, refresh };
}
