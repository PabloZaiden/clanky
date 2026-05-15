/**
 * Backend connection pool utilities.
 * Handles building connection configs and agent runtime commands.
 */

import type { BackendConnectionConfig } from "../../backends/types";
import type { ServerSettings } from "../../types/settings";
import { buildSshRemoteShellCommand } from "../remote-command-executor";
import { buildSshProcessConfig, getSshConnectionTargetFromSettings } from "../ssh-connection-target";
import { getProviderAcpCommand } from "../agent-runtime-command";

function buildAgentRuntimeCommand(settings: ServerSettings, directory: string): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const provider = settings.agent.provider;
  const providerCommand = getProviderAcpCommand(provider, settings.agent.transport);
  const providerInvocation = [providerCommand.command, ...providerCommand.args].join(" ");
  const remoteCommand = buildSshRemoteShellCommand(providerInvocation);

  if (settings.agent.transport === "stdio") {
    return providerCommand;
  }

  const sshTarget = getSshConnectionTargetFromSettings(settings);
  if (!sshTarget) {
    return providerCommand;
  }
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
export function buildConnectionConfig(settings: ServerSettings, directory: string): BackendConnectionConfig {
  const derivedCommand = buildAgentRuntimeCommand(settings, directory);
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
    directory,
  };
}
