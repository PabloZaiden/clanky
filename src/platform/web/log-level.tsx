import { useMemo } from "react";
import type { LogLevelName } from "../contracts";
import { useWebAppConfig } from "./webapp-config";

export interface WebAppLogLevelState {
  level?: LogLevelName;
  fromEnv?: boolean;
  loading: boolean;
  error?: Error;
  retry: () => Promise<void>;
}

export function useLogLevel(): WebAppLogLevelState {
  const { config, external, loading, error, refresh } = useWebAppConfig("useLogLevel");
  return useMemo(() => ({
    level: config?.logLevel.level ?? external?.logLevel,
    fromEnv: config?.logLevel.fromEnv ?? (external ? false : undefined),
    loading,
    error,
    retry: refresh,
  }), [config?.logLevel.fromEnv, config?.logLevel.level, external, error, loading, refresh]);
}
