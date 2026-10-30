import { DEFAULT_SSH_COLOR_TERM, DEFAULT_SSH_TERM } from "../ssh-terminal-env";

const ENVIRONMENT_KEYS = new Set([
  "COLORTERM",
  "DISPLAY",
  "GH_TOKEN",
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

export interface LocalTerminalSpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function buildLocalTerminalEnvironment(
  extra?: Record<string, string>,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (value !== undefined && (ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))) {
      environment[key] = value;
    }
  }
  environment["PATH"] ??= "/usr/local/bin:/usr/bin:/bin";
  environment["SHELL"] ??= "/bin/sh";
  environment["TERM"] ??= DEFAULT_SSH_TERM;
  environment["COLORTERM"] ??= DEFAULT_SSH_COLOR_TERM;
  return { ...environment, ...extra };
}
