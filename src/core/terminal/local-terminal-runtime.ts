/**
 * Platform-specific local terminal runtime selection.
 */

import { win32 } from "node:path";
import { DomainError } from "../domain-error";
import {
  DEFAULT_SSH_COLOR_TERM,
  DEFAULT_SSH_TERM,
} from "../ssh-terminal-env";

const POSIX_ENVIRONMENT_KEYS = new Set([
  "COLORTERM",
  "DISPLAY",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "WAYLAND_DISPLAY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);
const WINDOWS_ENVIRONMENT_KEYS = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PSMODULEPATH",
  "PUBLIC",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

export interface LocalTerminalSpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ResolvedWindowsTerminalShell {
  command: string;
  kind: "powershell" | "cmd";
}

export function isWindowsTerminalRuntime(): boolean {
  return process.platform === "win32";
}

export function buildLocalTerminalEnvironment(
  extra?: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  const windows = isWindowsTerminalRuntime();
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    const normalizedKey = key.toUpperCase();
    if (
      (windows && WINDOWS_ENVIRONMENT_KEYS.has(normalizedKey))
      || (
        !windows
        && (POSIX_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))
      )
    ) {
      environment[key] = value;
    }
  }
  if (!windows) {
    environment["PATH"] = environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
    environment["SHELL"] = environment["SHELL"] ?? "/bin/sh";
  }
  environment["TERM"] = environment["TERM"] ?? DEFAULT_SSH_TERM;
  environment["COLORTERM"] = environment["COLORTERM"]
    ?? DEFAULT_SSH_COLOR_TERM;
  for (const [key, value] of Object.entries(extra ?? {})) {
    environment[key] = value;
  }
  return environment;
}

export function resolveWindowsTerminalSpawn(
  cwd: string,
  environment: Record<string, string>,
): LocalTerminalSpawnConfig {
  const shell = resolveWindowsTerminalShell();
  return {
    command: shell.command,
    args: shell.kind === "powershell" ? ["-NoLogo"] : ["/Q"],
    cwd,
    env: environment,
  };
}

export function resolveWindowsTerminalShell(): ResolvedWindowsTerminalShell {
  for (const candidate of ["pwsh.exe", "pwsh"]) {
    const command = Bun.which(candidate);
    if (command) {
      return {
        command,
        kind: "powershell",
      };
    }
  }
  for (const candidate of ["powershell.exe", "powershell"]) {
    const command = Bun.which(candidate);
    if (command) {
      return {
        command,
        kind: "powershell",
      };
    }
  }

  const comSpec = process.env["ComSpec"] ?? process.env["COMSPEC"];
  if (
    comSpec
    && win32.isAbsolute(comSpec)
    && win32.basename(comSpec).toLowerCase() === "cmd.exe"
  ) {
    return {
      command: comSpec,
      kind: "cmd",
    };
  }
  const command = Bun.which("cmd.exe") ?? Bun.which("cmd");
  if (command) {
    return {
      command,
      kind: "cmd",
    };
  }
  throw new DomainError(
    "terminal_shell_unavailable",
    "No supported Windows terminal shell is available.",
  );
}

export function buildWindowsTerminalFallbackNotice(
  requestedPersistentSession: boolean,
  requestedTmux: boolean,
): string | undefined {
  if (!requestedPersistentSession && !requestedTmux) {
    return undefined;
  }
  return "Persistent terminal sessions and tmux are unavailable on Windows; using a direct terminal.";
}
