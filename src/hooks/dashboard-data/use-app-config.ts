/**
 * Sub-hook for app config, version, and server-level actions.
 */

import { useState, useCallback, useEffect } from "react";
import type { AppConfig, HealthResponse } from "../../types";
import { appFetch, setConfiguredPublicBasePath } from "../../lib/public-path";
import { useToast } from "../useToast";
import { createLogger } from "../../lib/logger";
import { purgeTerminalLoopsApi, type PurgeTerminalLoopsResult } from "../loopActions";

const log = createLogger("useAppConfig");

export interface UseAppConfigResult {
  remoteOnly: boolean;
  version: string | null;
  appSettingsResetting: boolean;
  appSettingsKilling: boolean;
  appSettingsPurgingTerminalLoops: boolean;
  resetAllSettings: () => Promise<boolean>;
  killServer: () => Promise<boolean>;
  purgeTerminalLoops: () => Promise<PurgeTerminalLoopsResult | null>;
}

export function useAppConfig(): UseAppConfigResult {
  const toast = useToast();

  const [remoteOnly, setRemoteOnly] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [appSettingsResetting, setAppSettingsResetting] = useState(false);
  const [appSettingsKilling, setAppSettingsKilling] = useState(false);
  const [appSettingsPurgingTerminalLoops, setAppSettingsPurgingTerminalLoops] = useState(false);

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

  const killServer = useCallback(async () => {
    setAppSettingsKilling(true);
    try {
      const response = await appFetch("/api/server/kill", { method: "POST" });
      if (!response.ok) {
        log.error("Failed to kill server: HTTP", response.status);
        toast.error("Failed to kill server");
      }
      return response.ok;
    } catch (error) {
      log.error("Failed to kill server:", error);
      toast.error("Failed to kill server");
      return false;
    } finally {
      setAppSettingsKilling(false);
    }
  }, []);

  const purgeTerminalLoops = useCallback(async (): Promise<PurgeTerminalLoopsResult | null> => {
    setAppSettingsPurgingTerminalLoops(true);
    try {
      return await purgeTerminalLoopsApi();
    } catch (error) {
      log.error("Failed to purge terminal-state loops:", error);
      toast.error("Failed to purge terminal-state loops");
      return null;
    } finally {
      setAppSettingsPurgingTerminalLoops(false);
    }
  }, [toast]);

  return {
    remoteOnly,
    version,
    appSettingsResetting,
    appSettingsKilling,
    appSettingsPurgingTerminalLoops,
    resetAllSettings,
    killServer,
    purgeTerminalLoops,
  };
}
