/**
 * SSH argument builders and remote shell command helpers.
 */

import { createHash } from "node:crypto";
import {
  getSshReliabilityPolicy,
  type SshReliabilityPolicy,
} from "../ssh-reliability-policy";
import type { SshAuthMode } from "./types";
import { quoteShell } from "./utils";

const CONTROL_PATH_VERSION = "v1";
const CONTROL_PERSIST = "60s";

export function buildSshRemoteShellCommand(remoteCommand: string): string {
  const shellBootstrapCommand = [
    'shell_path="${SHELL:-}"',
    'if [ -z "$shell_path" ]; then shell_path="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; fi',
    'if [ -z "$shell_path" ] || [ ! -x "$shell_path" ]; then shell_path="$(command -v sh 2>/dev/null || printf %s /bin/sh)"; fi',
    // ACP and command-executor streams do not provide a TTY; keep the login
    // environment without enabling shell job control in headless sessions.
    `exec "$shell_path" -lc ${quoteShell(remoteCommand)}`,
    `exec sh -lc ${quoteShell(remoteCommand)}`,
  ].join("; ");

  return `sh -lc ${quoteShell(shellBootstrapCommand)}`;
}

function getSshAuthArgs(authMode: SshAuthMode): string[] {
  if (authMode === "password") {
    return [
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
    ];
  }

  return ["-o", "BatchMode=yes"];
}

function buildSshControlPath(options: {
  authMode: SshAuthMode;
  port: number;
  target: string;
  identityFile?: string;
  connectionScope?: string;
}): string {
  const fingerprintInput = JSON.stringify({
    version: CONTROL_PATH_VERSION,
    authMode: options.authMode,
    target: options.target,
    port: options.port,
    identityFile: options.identityFile?.trim() || "",
    connectionScope: options.connectionScope?.trim() || "",
  });
  const fingerprint = createHash("sha256")
    .update(fingerprintInput)
    .digest("hex")
    .slice(0, 32);
  return `~/.ssh/clanky-cm-${CONTROL_PATH_VERSION}-${fingerprint}`;
}

export function buildSshMultiplexingArgs(options: {
  authMode: SshAuthMode;
  port: number;
  target: string;
  identityFile?: string;
  connectionScope?: string;
}): string[] {
  if (options.authMode === "password") {
    return [];
  }

  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${buildSshControlPath(options)}`,
    "-o",
    `ControlPersist=${CONTROL_PERSIST}`,
  ];
}

export function buildSshCommandArgs(options: {
  authMode: SshAuthMode;
  port: number;
  target: string;
  remoteCommand?: string;
  identityFile?: string;
  connectionScope?: string;
  policy?: SshReliabilityPolicy;
}): string[] {
  const identityFile = options.identityFile?.trim();
  const policy = options.policy ?? getSshReliabilityPolicy();
  return [
    ...getSshAuthArgs(options.authMode),
    ...buildSshMultiplexingArgs({
      authMode: options.authMode,
      port: options.port,
      target: options.target,
      identityFile,
      connectionScope: options.connectionScope,
    }),
    ...(identityFile
      ? [
          "-o",
          "IdentityAgent=none",
          "-o",
          "IdentitiesOnly=yes",
          "-i",
          identityFile,
        ]
      : []),
    "-o",
    `ConnectTimeout=${policy.connectTimeoutSeconds}`,
    "-o",
    `ConnectionAttempts=${policy.connectionAttempts}`,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    `ServerAliveInterval=${policy.serverAliveIntervalSeconds}`,
    "-o",
    `ServerAliveCountMax=${policy.serverAliveCountMax}`,
    "-p",
    String(options.port),
    options.target,
    ...(options.remoteCommand
      ? [
          "--",
          options.remoteCommand,
        ]
      : []),
  ];
}
