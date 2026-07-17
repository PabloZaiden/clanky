/**
 * Backend connection pool utilities.
 * Handles building connection configs and agent runtime commands.
 */

import type { BackendConnectionConfig } from "../../backends/types";
import type { ServerSettings } from "@/shared/settings";
import { buildSshRemoteShellCommand } from "../remote-command-executor";
import { buildSshProcessConfig, getSshConnectionTargetFromSettings } from "../ssh-connection-target";
import {
  buildProviderShellInvocation,
  buildProviderSpawnEnvironment,
  getProviderAcpCommand,
} from "../agent-runtime-command";
import {
  buildManagedContextShellBootstrap,
  buildManagedContextStdinPayload,
  withoutManagedContextEnvironment,
} from "../managed-context-environment";

function buildAgentRuntimeCommand(
  settings: ServerSettings,
  directory: string,
  runtimeEnvironment?: Record<string, string>,
): { command: string; args: string[]; env?: NodeJS.ProcessEnv; startupStdin?: string } {
  const provider = settings.agent.provider;
  const providerCommand = getProviderAcpCommand(provider, settings.agent.transport);

  if (settings.agent.transport === "stdio") {
    return {
      ...providerCommand,
      env: buildProviderSpawnEnvironment(providerCommand, process.env, runtimeEnvironment),
    };
  }

  const sshTarget = getSshConnectionTargetFromSettings(settings);
  if (!sshTarget) {
    return providerCommand;
  }
  const providerInvocation = buildProviderShellInvocation(
    providerCommand,
    withoutManagedContextEnvironment(runtimeEnvironment),
  );
  const remoteCommand = buildSshRemoteShellCommand(
    buildManagedContextShellBootstrap(runtimeEnvironment, providerInvocation),
  );
  const sshProcess = buildSshProcessConfig({
    target: sshTarget,
    remoteCommand,
    connectionScope: directory,
    passwordHandling: "environment",
  });
  return {
    command: sshProcess.command,
    args: sshProcess.args,
    env: sshProcess.env,
    startupStdin: buildManagedContextStdinPayload(runtimeEnvironment),
  };
}

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
  settings: ServerSettings,
  directory: string,
  runtimeEnvironment?: Record<string, string>,
): BackendConnectionConfig {
  const derivedCommand = buildAgentRuntimeCommand(settings, directory, runtimeEnvironment);
  const sshTarget = getSshConnectionTargetFromSettings(settings);
  return {
    mode: "spawn",
    provider: settings.agent.provider,
    transport: settings.agent.transport,
    hostname: sshTarget?.host,
    port: sshTarget?.port,
    username: sshTarget?.username,
    password: sshTarget?.password,
    identityFile: sshTarget?.identityFile,
    command: derivedCommand.command,
    args: derivedCommand.args,
    env: derivedCommand.env,
    startupStdin: derivedCommand.startupStdin,
    directory,
  };
}
