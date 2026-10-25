/**
 * Sub-hook for app config, version, and server-level actions.
 */

import { useState, useCallback } from "react";
import { createLogger, useToast, type WebAppConfigState } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import { isBrowserCollaborationClient } from "@/client-sdk/browser-runtime";
import { purgeTerminalTasksApi, type PurgeTerminalTasksResult } from "../taskActions";

const log = createLogger("useAppConfig");

export interface UseAppConfigResult {
  remoteOnly: boolean;
  version: string | null;
  appSettingsResetting: boolean;
  appSettingsPurgingTerminalTasks: boolean;
  resetAllSettings: () => Promise<boolean>;
  purgeTerminalTasks: () => Promise<PurgeTerminalTasksResult | null>;
}

export function useAppConfig(config: WebAppConfigState["config"]): UseAppConfigResult {
  const toast = useToast();

  const remoteOnly = isBrowserCollaborationClient() || Boolean(config && "remoteOnly" in config && config.remoteOnly === true);
  const version = config?.version ?? null;
  const [appSettingsResetting, setAppSettingsResetting] = useState(false);
  const [appSettingsPurgingTerminalTasks, setAppSettingsPurgingTerminalTasks] = useState(false);

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

  const purgeTerminalTasks = useCallback(async (): Promise<PurgeTerminalTasksResult | null> => {
    setAppSettingsPurgingTerminalTasks(true);
    try {
      return await purgeTerminalTasksApi();
    } catch (error) {
      log.error("Failed to purge terminal-state tasks:", error);
      toast.error("Failed to purge terminal-state tasks");
      return null;
    } finally {
      setAppSettingsPurgingTerminalTasks(false);
    }
  }, [toast]);

  return {
    remoteOnly,
    version,
    appSettingsResetting,
    appSettingsPurgingTerminalTasks,
    resetAllSettings,
    purgeTerminalTasks,
  };
}
