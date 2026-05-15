/**
 * Shell command builders for the SSH terminal bridge.
 */

import type { SshConnectionMode, SshServerSession, SshSession, Workspace } from "../../types";
import { buildSshRemoteShellCommand } from "../remote-command-executor";
import {
  buildPersistentSessionAttachCommand,
} from "../ssh-persistent-session";
import { buildShellBootstrapCommand } from "../ssh-shell-bootstrap";
import { DEFAULT_SSH_COLOR_TERM, DEFAULT_SSH_TERM } from "../ssh-terminal-env";
import {
  buildSshProcessConfig,
  type SshConnectionTarget,
  getSshConnectionTargetFromWorkspace,
} from "../ssh-connection-target";
import { getEffectiveSshConnectionMode } from "../../utils";

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildAttachCommand(session: {
  config: { id: string; remoteSessionName: string; directory?: string; useTmux?: boolean };
}): string {
  return buildPersistentSessionAttachCommand(session);
}

export function buildDirectTtyFilePath(sessionId: string): string {
  return `/tmp/ralpher-terminal-${sessionId}.tty`;
}

export function buildDirectShellCommand(session: { config: { id: string; directory?: string; useTmux?: boolean } }): string {
  const ttyFile = quoteShell(buildDirectTtyFilePath(session.config.id));
  return [
    `tty_file=${ttyFile}`,
    "tty_path=$(tty);",
    "if [ -z \"$tty_path\" ] || [ \"$tty_path\" = \"not a tty\" ]; then",
    "echo 'Failed to determine remote SSH tty.' >&2;",
    "exit 1;",
    "fi;",
    "printf '%s\\n' \"$tty_path\" > \"$tty_file\";",
    "trap 'rm -f \"$tty_file\"' EXIT HUP INT TERM;",
    buildShellBootstrapCommand({
      directory: session.config.directory,
      useTmux: session.config.useTmux,
    }),
  ].filter((part) => part.length > 0).join(" ");
}

function buildSessionStartupCommand(
  session: {
    config: {
      id: string;
      remoteSessionName: string;
      directory?: string;
      connectionMode: SshConnectionMode;
      useTmux?: boolean;
    };
    state?: { runtimeConnectionMode?: SshConnectionMode };
  },
): string {
  return getEffectiveSshConnectionMode(session) === "direct"
    ? buildDirectShellCommand(session)
    : buildPersistentSessionAttachCommand(session);
}

function buildSpawnEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const configuredTerm = process.env["TERM"]?.trim();
  const configuredColorTerm = process.env["COLORTERM"]?.trim();
  return {
    ...process.env,
    ...extraEnv,
    TERM: configuredTerm && configuredTerm.length > 0 ? configuredTerm : DEFAULT_SSH_TERM,
    COLORTERM: configuredColorTerm && configuredColorTerm.length > 0 ? configuredColorTerm : DEFAULT_SSH_COLOR_TERM,
  };
}

export function buildSshSpawnConfig(workspace: Workspace, session: SshSession): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const target = getSshConnectionTargetFromWorkspace(workspace);
  const remoteCommand = buildSshRemoteShellCommand(buildSessionStartupCommand(session));
  return buildSshProcessConfig({
    target,
    remoteCommand,
    connectionScope: workspace.directory,
    extraArgs: ["-tt"],
    passwordHandling: "environment",
    baseEnv: buildSpawnEnv(),
  });
}

export function buildStandaloneSshSpawnConfig(target: SshConnectionTarget, session: SshServerSession): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const remoteCommand = buildSshRemoteShellCommand(buildSessionStartupCommand(session));
  return buildSshProcessConfig({
    target,
    remoteCommand,
    extraArgs: ["-tt"],
    passwordHandling: "environment",
    baseEnv: buildSpawnEnv(),
  });
}

export function buildDirectReadyCommand(sessionId: string): string {
  const ttyFile = quoteShell(buildDirectTtyFilePath(sessionId));
  return [
    `tty_file=${ttyFile}`,
    "if [ ! -r \"$tty_file\" ]; then",
    "exit 1;",
    "fi;",
    "tty_path=$(cat \"$tty_file\" 2>/dev/null || true);",
    "[ -n \"$tty_path\" ]",
  ].join("\n");
}

export function buildDirectResizeCommand(sessionId: string, cols: number, rows: number): string {
  const ttyFile = quoteShell(buildDirectTtyFilePath(sessionId));
  return [
    `tty_file=${ttyFile}`,
    `cols=${String(cols)}`,
    `rows=${String(rows)}`,
    "if [ ! -r \"$tty_file\" ]; then",
    "echo 'Direct SSH tty is not ready' >&2;",
    "exit 1;",
    "fi;",
    "tty_path=$(cat \"$tty_file\" 2>/dev/null || true);",
    "if [ -z \"$tty_path\" ]; then",
    "echo 'Direct SSH tty is not ready' >&2;",
    "exit 1;",
    "fi;",
    "exec stty cols \"$cols\" rows \"$rows\" < \"$tty_path\"",
  ].join("\n");
}
