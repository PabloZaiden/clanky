/**
 * Backend connection pool utilities.
 * Builds connection configs for local or Mesh-owned runtimes.
 */

import type { BackendConnectionConfig } from "../../backends/types";
import type { RuntimeServerSettings } from "@/shared/settings";
import { withoutManagedContextEnvironment } from "../managed-context-environment";

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
  const isAcp = settings.agent.adapter === "acp";
  const environment = isAcp ? withoutManagedContextEnvironment(runtimeEnvironment) : runtimeEnvironment;
  return {
    provider: settings.agent.provider,
    transport: settings.agent.transport,
    ...(environment ? { env: environment } : {}),
    managedEnvironment: isAcp ? undefined : runtimeEnvironment,
    directory,
  };
}
