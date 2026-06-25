/**
 * Application configuration helpers.
 * Reads configuration from environment variables.
 */

import type { AppConfig } from "../types/api";

export function isTruthyEnvFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Check if the application is running in remote-only mode.
 * When enabled, spawning local servers is disabled and only
 * connecting to remote servers is allowed.
 * 
 * Set CLANKY_REMOTE_ONLY=true, 1, or yes to enable.
 */
export function isRemoteOnlyMode(): boolean {
  return isTruthyEnvFlag("CLANKY_REMOTE_ONLY");
}

/**
 * Check if the built-in mock ACP runtime should be used.
 *
 * Set CLANKY_MOCK_ACP=true, 1, or yes to enable.
 */
export function isMockAcpEnabled(): boolean {
  return isTruthyEnvFlag("CLANKY_MOCK_ACP");
}

/**
 * Check if same-origin request protection should be bypassed.
 *
 * Intended for development setups where the browser origin differs from the
 * backend origin on purpose.
 *
 * Set CLANKY_DISABLE_SAME_ORIGIN_CHECK=true, 1, or yes to disable.
 */
export function isSameOriginCheckDisabled(): boolean {
  return isTruthyEnvFlag("CLANKY_DISABLE_SAME_ORIGIN_CHECK");
}

/**
 * Get the current application configuration.
 */
export function getAppConfig(): AppConfig {
  return {
    remoteOnly: isRemoteOnlyMode(),
    publicBasePath: null,
  };
}
