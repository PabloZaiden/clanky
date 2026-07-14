/**
 * Shared SSH connection target helpers for workspace-backed and standalone SSH
 * runtimes.
 */

import type { ServerSettings, SshServerConfig, Workspace } from "@/shared";
import { buildSshCommandArgs } from "./remote-command-executor";

export interface SshConnectionTarget {
  host: string;
  port: number;
  username?: string;
  password?: string;
  identityFile?: string;
}

export interface SshProcessConfig {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface BuildSshProcessConfigOptions {
  target: SshConnectionTarget;
  remoteCommand?: string;
  extraArgs?: string[];
  connectionScope?: string;
  passwordHandling?: "environment" | "argument";
  baseEnv?: NodeJS.ProcessEnv;
  env?: Record<string, string>;
}

export function getSshConnectionTargetFromSettings(settings: ServerSettings): SshConnectionTarget | null {
  if (settings.agent.transport !== "ssh") {
    return null;
  }

  const host = settings.agent.hostname.trim();
  if (!host) {
    throw new Error("SSH settings require a hostname");
  }

  return {
    host,
    port: settings.agent.port ?? 22,
    username: settings.agent.username?.trim() || undefined,
    password: settings.agent.password?.trim() || undefined,
    identityFile: settings.agent.identityFile?.trim() || undefined,
  };
}

export function getSshConnectionTargetFromWorkspace(workspace: Workspace): SshConnectionTarget {
  const target = getSshConnectionTargetFromSettings(workspace.serverSettings);
  if (!target) {
    throw new Error("This operation requires a workspace configured with ssh transport");
  }
  return target;
}

export function buildSshAuthority(target: SshConnectionTarget): string {
  return target.username
    ? `${target.username}@${target.host}`
    : target.host;
}

export function getSshConnectionTargetFromServer(
  server: SshServerConfig,
  password?: string,
): SshConnectionTarget {
  const host = server.address.trim();
  if (!host) {
    throw new Error("SSH server requires an address");
  }
  return {
    host,
    port: 22,
    username: server.username.trim() || undefined,
    password: password?.trim() || undefined,
  };
}

export function buildSshProcessConfig(options: BuildSshProcessConfigOptions): SshProcessConfig {
  const password = options.target.password?.trim();
  const baseEnv = {
    ...(options.baseEnv ?? process.env),
    ...(options.env ?? {}),
  };
  const sshArgs = [
    ...(options.extraArgs ?? []),
    ...buildSshCommandArgs({
      authMode: password ? "password" : "batch",
      port: options.target.port,
      target: buildSshAuthority(options.target),
      remoteCommand: options.remoteCommand,
      identityFile: options.target.identityFile,
      connectionScope: options.connectionScope,
    }),
  ];

  if (!password) {
    return {
      command: "ssh",
      args: sshArgs,
      env: baseEnv,
    };
  }

  if (options.passwordHandling === "argument") {
    return {
      command: "sshpass",
      args: ["-p", password, "ssh", ...sshArgs],
      env: baseEnv,
    };
  }

  return {
    command: "sshpass",
    args: ["-e", "ssh", ...sshArgs],
    env: {
      ...baseEnv,
      SSHPASS: password,
    },
  };
}
