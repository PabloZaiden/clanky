import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError } from "./request-lifecycle";

export type PreferenceOperation = "load" | "save";

export interface PreferenceErrorContext<T> {
  operation: PreferenceOperation;
  error: unknown;
  value?: T;
}

export interface PreferenceSaveOptions {
  /**
   * Preserve a domain hook's existing rejected-save contract when required.
   * Lifecycle errors are still recorded and reported before propagation.
   */
  throwOnError?: boolean;
}

export interface UsePreferenceLifecycleOptions<T> {
  initialValue: T;
  load: (signal: AbortSignal) => Promise<T>;
  save: (value: T, signal: AbortSignal) => Promise<T | void>;
  onError?: (context: PreferenceErrorContext<T>) => void;
}

export interface UsePreferenceLifecycleResult<T> {
  value: T;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  saveValue: (value: T, options?: PreferenceSaveOptions) => Promise<void>;
}

export function usePreferenceLifecycle<T>({
  initialValue,
  load,
  save,
  onError,
}: UsePreferenceLifecycleOptions<T>): UsePreferenceLifecycleResult<T> {
  const [value, setValue] = useState(initialValue);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadRequestIdRef = useRef(0);
  const saveControllerRef = useRef<AbortController | null>(null);
  const saveRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }

    const requestId = ++loadRequestIdRef.current;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const isActiveRequest = () =>
      isMountedRef.current
      && loadControllerRef.current === controller
      && loadRequestIdRef.current === requestId;

    setLoading(true);
    setError(null);

    try {
      const nextValue = await load(controller.signal);
      if (!isActiveRequest() || controller.signal.aborted) {
        return;
      }
      setValue(nextValue);
    } catch (refreshError) {
      if (controller.signal.aborted || isAbortError(refreshError) || !isActiveRequest()) {
        return;
      }
      setError(String(refreshError));
      onError?.({ operation: "load", error: refreshError });
    } finally {
      if (isActiveRequest()) {
        loadControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [load, onError]);

  const saveValue = useCallback(async (
    nextValue: T,
    options: PreferenceSaveOptions = {},
  ) => {
    if (!isMountedRef.current) {
      return;
    }

    const requestId = ++saveRequestIdRef.current;
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    const isActiveRequest = () =>
      isMountedRef.current
      && saveControllerRef.current === controller
      && saveRequestIdRef.current === requestId;

    setSaving(true);
    setError(null);

    try {
      const savedValue = await save(nextValue, controller.signal);
      if (!isActiveRequest() || controller.signal.aborted) {
        return;
      }
      setValue(savedValue === undefined ? nextValue : savedValue);
    } catch (saveError) {
      if (controller.signal.aborted || isAbortError(saveError) || !isActiveRequest()) {
        return;
      }
      setError(String(saveError));
      onError?.({ operation: "save", error: saveError, value: nextValue });
      if (options.throwOnError) {
        throw saveError;
      }
    } finally {
      if (isActiveRequest()) {
        saveControllerRef.current = null;
        setSaving(false);
      }
    }
  }, [onError, save]);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();

    return () => {
      isMountedRef.current = false;
      loadRequestIdRef.current += 1;
      saveRequestIdRef.current += 1;
      loadControllerRef.current?.abort();
      saveControllerRef.current?.abort();
      loadControllerRef.current = null;
      saveControllerRef.current = null;
    };
  }, [refresh]);

  return {
    value,
    loading,
    saving,
    error,
    refresh,
    saveValue,
  };
}
