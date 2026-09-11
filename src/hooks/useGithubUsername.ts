import { useCallback } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import {
  usePreferenceLifecycle,
  type PreferenceErrorContext,
} from "./usePreferenceLifecycle";

const log = createLogger("useGithubUsername");

export interface UseGithubUsernameResult {
  githubUsername: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateGithubUsername: (githubUsername: string) => Promise<string | null>;
}

export function useGithubUsername(): UseGithubUsernameResult {
  const loadPreference = useCallback(async (signal: AbortSignal): Promise<string> => {
    const data = await apiRequest<{ githubUsername?: string | null }>(
      "/api/preferences/github-username",
      {
        signal,
        action: "Load GitHub username",
        fallbackMessage: "Failed to load GitHub username",
      },
    );
    return data.githubUsername?.trim() ?? "";
  }, []);

  const savePreference = useCallback(async (
    githubUsername: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const data = await apiRequest<{ githubUsername?: string | null }>(
      "/api/preferences/github-username",
      {
        signal,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUsername }),
        action: "Save GitHub username",
        fallbackMessage: "Failed to save GitHub username",
      },
    );
    return data.githubUsername?.trim() ?? "";
  }, []);

  const handlePreferenceError = useCallback((context: PreferenceErrorContext<string>) => {
    const action = context.operation === "load" ? "load" : "save";
    log.error(`Failed to ${action} GitHub username`, {
      error: String(context.error),
    });
  }, []);

  const preference = usePreferenceLifecycle({
    initialValue: "",
    load: loadPreference,
    save: savePreference,
    onError: handlePreferenceError,
  });

  const updateGithubUsername = useCallback(async (githubUsername: string): Promise<string | null> => {
    const normalized = githubUsername.trim();
    try {
      await preference.saveValue(normalized, { throwOnError: true });
      return normalized;
    } catch {
      return null;
    }
  }, [preference.saveValue]);

  return {
    githubUsername: preference.value,
    loading: preference.loading,
    saving: preference.saving,
    error: preference.error,
    refresh: preference.refresh,
    updateGithubUsername,
  };
}
