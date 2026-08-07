import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "./request-lifecycle";

export interface ResourceRefreshOptions {
  showLoading?: boolean;
}

export interface UseResourceRefreshOptions<T> {
  load: (signal: AbortSignal) => Promise<T>;
  onLoaded: (value: T) => void;
  onRefreshStart?: () => void;
  onError?: (error: unknown) => void;
}

export interface UseResourceRefreshResult {
  loading: boolean;
  refresh: (options?: ResourceRefreshOptions) => Promise<void>;
}

export function useResourceRefresh<T>({
  load,
  onLoaded,
  onRefreshStart,
  onError,
}: UseResourceRefreshOptions<T>): UseResourceRefreshResult {
  const [loading, setLoading] = useState(true);
  const isMountedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const loadRef = useRef(load);
  const onLoadedRef = useRef(onLoaded);
  const onRefreshStartRef = useRef(onRefreshStart);
  const onErrorRef = useRef(onError);

  loadRef.current = load;
  onLoadedRef.current = onLoaded;
  onRefreshStartRef.current = onRefreshStart;
  onErrorRef.current = onError;

  const refresh = useCallback(async (options: ResourceRefreshOptions = {}) => {
    if (!isMountedRef.current) {
      return;
    }

    const showLoading = options.showLoading ?? true;
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isActiveRequest = () =>
      isMountedRef.current
      && controllerRef.current === controller
      && requestIdRef.current === requestId;

    onRefreshStartRef.current?.();
    if (showLoading) {
      setLoading(true);
    }

    let value: T;
    try {
      value = await loadRef.current(controller.signal);
    } catch (refreshError) {
      if (controller.signal.aborted || isAbortError(refreshError) || !isActiveRequest()) {
        return;
      }
      onErrorRef.current?.(refreshError);
      if (isActiveRequest()) {
        controllerRef.current = null;
        setLoading(false);
      }
      return;
    }

    if (!isActiveRequest() || controller.signal.aborted) {
      return;
    }
    onLoadedRef.current(value);
    if (isActiveRequest()) {
      controllerRef.current = null;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  return { loading, refresh };
}
