/**
 * Application configuration helpers.
 * Reads configuration from environment variables.
 */

import type { AppConfig } from "../types/api";

function isTruthyEnvFlag(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Check if the application is running in remote-only mode.
 * When enabled, spawning local servers is disabled and only
 * connecting to remote servers is allowed.
 * 
 * Set RALPHER_REMOTE_ONLY=true, 1, or yes to enable.
 */
export function isRemoteOnlyMode(): boolean {
  return isTruthyEnvFlag("RALPHER_REMOTE_ONLY");
}

/**
 * Check if the built-in mock ACP runtime should be used.
 *
 * Set RALPHER_MOCK_ACP=true, 1, or yes to enable.
 */
export function isMockAcpEnabled(): boolean {
  return isTruthyEnvFlag("RALPHER_MOCK_ACP");
}

/**
 * Get the current application configuration.
 */
export function getAppConfig(): AppConfig {
  return {
    remoteOnly: isRemoteOnlyMode(),
    basicAuthEnabled: false,
    passkeyAuth: {
      passkeyConfigured: false,
      passkeyDisabled: false,
      passkeyRequired: false,
      authenticated: false,
    },
    publicBasePath: null,
  };
}
