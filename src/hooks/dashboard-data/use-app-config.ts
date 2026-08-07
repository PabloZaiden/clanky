/**
 * Sub-hook for app config, version, and server-level actions.
 */

import { useState, useCallback, useEffect } from "react";
import type { AppConfig, HealthResponse } from "@/contracts";
import { createLogger, useToast } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import { setConfiguredPublicBasePath } from "../../lib/public-path";
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
    let active = true;
    void (async () => {
      try {
        const config = await apiRequest<AppConfig>("/api/config", {
          action: "Load app configuration",
          fallbackMessage: "Failed to load app configuration",
        });
        if (!active) {
          return;
        }
        setConfiguredPublicBasePath(config.publicBasePath ?? undefined);
        setRemoteOnly(config.remoteOnly);
      } catch {
        // Configuration is optional during initial startup; keep the defaults.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await apiRequest<HealthResponse>("/api/health", {
          action: "Load server health",
          fallbackMessage: "Failed to load server health",
        });
        if (active) {
          setVersion(data.version);
        }
      } catch {
        // Health is informational; leave the version unset when unavailable.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

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
