/**
 * Sub-hook for app config, version, and server-level actions.
 */

import { useState, useCallback } from "react";
import { createLogger, useToast } from "@pablozaiden/webapp/web";
import { type WebAppConfigState } from "@/platform/web/webapp-config";
import { apiRequest } from "../../lib/api-client";
import { isBrowserCollaborationClient } from "@/client-sdk/browser-runtime";

const log = createLogger("useAppConfig");

export interface UseAppConfigResult {
  remoteOnly: boolean;
  version: string | null;
  appSettingsResetting: boolean;
  resetAllSettings: () => Promise<boolean>;
}

export function useAppConfig(config: WebAppConfigState["config"]): UseAppConfigResult {
  const toast = useToast();

  const remoteOnly = isBrowserCollaborationClient() || Boolean(config && "remoteOnly" in config && config.remoteOnly === true);
  const version = config?.version ?? null;
  const [appSettingsResetting, setAppSettingsResetting] = useState(false);

  const resetAllSettings = useCallback(async () => {
    setAppSettingsResetting(true);
    try {
      await apiRequest("/api/settings/reset-all", {
        method: "POST",
        action: "Reset all settings",
        fallbackMessage: "Failed to reset settings",
      });
      return true;
    } catch (error) {
      log.error("Failed to reset settings:", error);
      toast.error("Failed to reset settings");
      return false;
    } finally {
      setAppSettingsResetting(false);
    }
  }, [toast]);

  return {
    remoteOnly,
    version,
    appSettingsResetting,
    resetAllSettings,
  };
}
