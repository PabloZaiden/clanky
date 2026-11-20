import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeStyles, useAsyncOperation, useRealtimeRefresh } from "@pablozaiden/webapp/web";
import { AppearancePreferenceSchema, DEFAULT_APPEARANCE, type AppearancePreference } from "@/contracts/schemas/appearance";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { appJson } from "./api-client";
import { clientScopedStorageKey } from "./client-session";
import { readStorage, writeStorage } from "./storage";
import { selectedAppearanceTheme } from "./appearance-themes";

interface AppearanceState {
  saved: AppearancePreference;
  draft: AppearancePreference;
  pending: boolean;
  error?: Error;
  preview(value: AppearancePreference | undefined): void;
  save(value: AppearancePreference): Promise<void>;
  retry(): Promise<void>;
}

const AppearanceContext = createContext<AppearanceState | null>(null);

export function AppearanceProvider({ accountBacked, children }: { accountBacked: boolean; children: ReactNode }) {
  const [saved, setSaved] = useState(DEFAULT_APPEARANCE);
  const [preview, setPreview] = useState<AppearancePreference>();
  const [error, setError] = useState<Error>();
  const { pending, start, finish, isCurrent } = useAsyncOperation({ initialPending: true });
  const key = clientScopedStorageKey("clanky.appearance");

  const retry = useCallback(async (signal?: AbortSignal) => {
    const token = start({ replace: true });
    if (!token) return;
    setError(undefined);
    try {
      let value: unknown;
      if (accountBacked) {
        value = await appJson<unknown>("/api/preferences/appearance", {
          signal: signal ? AbortSignal.any([signal, token.signal]) : token.signal,
        });
      } else {
        const result = readStorage(key);
        if (!result.ok) throw result.error;
        value = result.value === null ? DEFAULT_APPEARANCE : JSON.parse(result.value);
      }
      const next = AppearancePreferenceSchema.parse(value);
      if (isCurrent(token) && !signal?.aborted) setSaved(next);
    } catch (value) {
      if (isCurrent(token) && !signal?.aborted) setError(value instanceof Error ? value : new Error(String(value)));
    } finally {
      finish(token);
    }
  }, [accountBacked, key, start, finish, isCurrent]);

  useEffect(() => { if (!accountBacked) void retry(); }, [accountBacked, retry]);
  useRealtimeRefresh({
    enabled: accountBacked,
    resources: [CLANKY_REALTIME_RESOURCES.appearance],
    refresh: (_event, signal) => retry(signal),
    onError: setError,
    deps: [accountBacked, key],
  });
  useEffect(() => {
    setPreview(current => current && JSON.stringify(current) === JSON.stringify(saved) ? undefined : current);
  }, [saved]);

  const save = useCallback(async (value: AppearancePreference) => {
    if (error) throw error;
    const next = AppearancePreferenceSchema.parse(value);
    const token = start();
    if (!token) throw new Error("Appearance settings are busy. Try again when the current operation finishes.");
    setError(undefined);
    try {
      if (accountBacked) {
        await appJson("/api/preferences/appearance", { method: "PUT", body: JSON.stringify(next) });
      } else {
        const result = writeStorage(key, JSON.stringify(next));
        if (!result.ok) throw result.error;
      }
      if (isCurrent(token)) {
        setSaved(next);
        setPreview(undefined);
      }
    } finally {
      finish(token);
    }
  }, [accountBacked, key, error, start, finish, isCurrent]);
  const state = useMemo<AppearanceState>(() => ({
    saved, draft: preview ?? saved, pending, error, preview: setPreview, save, retry,
  }), [saved, preview, pending, error, save, retry]);

  return <AppearanceContext.Provider value={state}>
    <ThemeStyles theme={selectedAppearanceTheme(preview ?? saved).style} />
    {children}
  </AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("useAppearance requires AppearanceProvider.");
  return context;
}
