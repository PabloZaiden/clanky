/**
 * Backend connection pool utilities.
 * Builds connection configs for local or Mesh-owned runtimes.
 */

import type { BackendConnectionConfig } from "../../backends/types";
import type { RuntimeServerSettings } from "@/shared/settings";

/**
 * Build a BackendConnectionConfig from ServerSettings and a directory.
 * This is a utility function for cases where you have settings that aren't
 * from the backendManager (e.g., testing a connection with proposed settings).
 *
 * @param settings - Server settings to use
 * @param directory - Working directory for the connection
 * @returns A complete BackendConnectionConfig
 */
export function buildConnectionConfig(
  settings: RuntimeServerSettings,
  directory: string,
  runtimeEnvironment?: Record<string, string>,
): BackendConnectionConfig {
  return {
    provider: settings.agent.provider,
    ...(runtimeEnvironment ? { env: runtimeEnvironment } : {}),
    managedEnvironment: runtimeEnvironment,
    directory,
  };
}
