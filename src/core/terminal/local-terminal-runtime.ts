import { DEFAULT_COLOR_TERM, DEFAULT_TERM } from "./terminal-env";

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
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  environment["PATH"] ??= "/usr/local/bin:/usr/bin:/bin";
  environment["SHELL"] ??= "/bin/sh";
  environment["TERM"] ??= DEFAULT_TERM;
  environment["COLORTERM"] ??= DEFAULT_COLOR_TERM;
  return { ...environment, ...extra };
}
