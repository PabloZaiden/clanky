import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppConfig, PasskeyAuthStatusResponse } from "../types/api";
import { appFetch, PASSKEY_AUTH_REQUIRED_EVENT, setConfiguredPublicBasePath } from "../lib/public-path";
import { useToast } from "./useToast";
import { createLogger } from "../lib/logger";

const log = createLogger("usePasskeyAuth");

const DEFAULT_PASSKEY_STATUS: PasskeyAuthStatusResponse = {
  passkeyConfigured: false,
  passkeyDisabled: false,
  passkeyRequired: false,
  authenticated: false,
};

interface ApiErrorResponse {
  message?: string;
  error?: string;
}

interface PasskeyActionResponse {
  success: boolean;
}

export interface UsePasskeyAuthResult {
  status: PasskeyAuthStatusResponse;
  loading: boolean;
  refreshing: boolean;
  authenticating: boolean;
  registering: boolean;
  loggingOut: boolean;
  removingPasskey: boolean;
  error: string | null;
  clearError: () => void;
  refreshStatus: () => Promise<void>;
  loginWithPasskey: () => Promise<boolean>;
  registerPasskey: (name?: string) => Promise<boolean>;
  logout: () => Promise<boolean>;
  removePasskey: () => Promise<boolean>;
}

async function readApiError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as ApiErrorResponse;
    return data.message || data.error || `Request failed with status ${String(response.status)}`;
  } catch {
    return `Request failed with status ${String(response.status)}`;
  }
}

function getPasskeyStatus(config: AppConfig): PasskeyAuthStatusResponse {
  return config.passkeyAuth;
}

export function usePasskeyAuth(): UsePasskeyAuthResult {
  const toast = useToast();
  const [status, setStatus] = useState<PasskeyAuthStatusResponse>(DEFAULT_PASSKEY_STATUS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [removingPasskey, setRemovingPasskey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const response = await appFetch("/api/config");
    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const config = (await response.json()) as AppConfig;
    setConfiguredPublicBasePath(config.publicBasePath ?? undefined);
    setStatus(getPasskeyStatus(config));
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialState() {
      try {
        const response = await appFetch("/api/config", {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }

        const config = (await response.json()) as AppConfig;
        setConfiguredPublicBasePath(config.publicBasePath ?? undefined);
        setStatus(getPasskeyStatus(config));
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted) {
          return;
        }
        const message = String(loadError);
        log.error("Failed to load passkey auth state", { error: message });
        setError(message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadInitialState();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    function handleAuthRequired() {
      setRefreshing(true);
      void refreshStatus()
        .catch((refreshError: unknown) => {
          const message = String(refreshError);
          log.error("Failed to refresh passkey auth state after unauthorized response", { error: message });
          setError(message);
        })
        .finally(() => {
          setRefreshing(false);
        });
    }

    window.addEventListener(PASSKEY_AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () => {
      window.removeEventListener(PASSKEY_AUTH_REQUIRED_EVENT, handleAuthRequired);
    };
  }, [refreshStatus]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const loginWithPasskey = useCallback(async () => {
    setAuthenticating(true);
    setError(null);
    try {
      const optionsResponse = await appFetch("/api/passkey-auth/authentication/options");
      if (!optionsResponse.ok) {
        throw new Error(await readApiError(optionsResponse));
      }

      const options = await optionsResponse.json();
      const passkeyResponse = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await appFetch("/api/passkey-auth/authentication/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ response: passkeyResponse }),
      });

      if (!verifyResponse.ok) {
        throw new Error(await readApiError(verifyResponse));
      }

      await refreshStatus();
      return true;
    } catch (loginError) {
      const message = String(loginError);
      log.error("Failed to authenticate with passkey", { error: message });
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setAuthenticating(false);
    }
  }, [refreshStatus, toast]);

  const registerPasskey = useCallback(async (name?: string) => {
    setRegistering(true);
    setError(null);
    try {
      const optionsResponse = await appFetch("/api/passkey-auth/registration/options");
      if (!optionsResponse.ok) {
        throw new Error(await readApiError(optionsResponse));
      }

      const options = await optionsResponse.json();
      const passkeyResponse = await startRegistration({ optionsJSON: options });
      const verifyResponse = await appFetch("/api/passkey-auth/registration/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name?.trim() || undefined,
          response: passkeyResponse,
        }),
      });

      if (!verifyResponse.ok) {
        throw new Error(await readApiError(verifyResponse));
      }

      await refreshStatus();
      return true;
    } catch (registrationError) {
      const message = String(registrationError);
      log.error("Failed to register passkey", { error: message });
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setRegistering(false);
    }
  }, [refreshStatus, toast]);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    setError(null);
    try {
      const response = await appFetch("/api/passkey-auth/logout", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      await refreshStatus();
      return true;
    } catch (logoutError) {
      const message = String(logoutError);
      log.error("Failed to log out of passkey auth session", { error: message });
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setLoggingOut(false);
    }
  }, [refreshStatus, toast]);

  const removePasskey = useCallback(async () => {
    setRemovingPasskey(true);
    setError(null);
    try {
      const response = await appFetch("/api/passkey-auth/passkey", {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const data = (await response.json()) as PasskeyActionResponse;
      if (!data.success) {
        throw new Error("Failed to remove passkey");
      }

      await refreshStatus();
      return true;
    } catch (removeError) {
      const message = String(removeError);
      log.error("Failed to remove configured passkey", { error: message });
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setRemovingPasskey(false);
    }
  }, [refreshStatus, toast]);

  return useMemo(() => ({
    status,
    loading,
    refreshing,
    authenticating,
    registering,
    loggingOut,
    removingPasskey,
    error,
    clearError,
    refreshStatus: async () => {
      setRefreshing(true);
      try {
        await refreshStatus();
        setError(null);
      } catch (refreshError) {
        const message = String(refreshError);
        log.error("Failed to refresh passkey auth state", { error: message });
        setError(message);
        throw refreshError;
      } finally {
        setRefreshing(false);
      }
    },
    loginWithPasskey,
    registerPasskey,
    logout,
    removePasskey,
  }), [
    status,
    loading,
    refreshing,
    authenticating,
    registering,
    loggingOut,
    removingPasskey,
    error,
    clearError,
    loginWithPasskey,
    registerPasskey,
    logout,
    removePasskey,
    refreshStatus,
  ]);
}
