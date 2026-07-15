/**
 * Sub-hook for app config, version, and server-level actions.
 */

import { useState, useCallback, useEffect } from "react";
import type { AppConfig, HealthResponse } from "@/contracts";
import { useToast } from "@pablozaiden/webapp/web";
import { appFetch, setConfiguredPublicBasePath } from "../../lib/public-path";
import { createLogger } from "../../lib/logger";
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

export function useAppConfig(): UseAppConfigResult {
  const toast = useToast();

  const [remoteOnly, setRemoteOnly] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [appSettingsResetting, setAppSettingsResetting] = useState(false);
  const [appSettingsPurgingTerminalTasks, setAppSettingsPurgingTerminalTasks] = useState(false);

  useEffect(() => {
    appFetch("/api/config")
      .then((res) => res.json())
      .then((config: AppConfig) => {
        setConfiguredPublicBasePath(config.publicBasePath ?? undefined);
        setRemoteOnly(config.remoteOnly);
      })
      .catch(() => {
        // Ignore errors, default to false
      });
  }, []);

  useEffect(() => {
    appFetch("/api/health")
      .then((res) => res.json())
      .then((data: HealthResponse) => {
        setVersion(data.version);
      })
      .catch(() => {
        // Ignore errors
      });
  }, []);

  const resetAllSettings = useCallback(async () => {
    setAppSettingsResetting(true);
    try {
      const response = await appFetch("/api/settings/reset-all", { method: "POST" });
      if (!response.ok) {
        toast.error("Failed to reset settings");
      }
      return response.ok;
    } catch (error) {
      log.error("Failed to reset settings:", error);
      toast.error("Failed to reset settings");
      return false;
    } finally {
      setAppSettingsResetting(false);
    }
  }, []);

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
