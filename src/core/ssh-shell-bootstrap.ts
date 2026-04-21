/**
 * Shared shell bootstrap helpers used by SSH terminal startup commands.
 */

import { DEFAULT_SSH_COLOR_TERM } from "./ssh-terminal-env";

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildShellBootstrapCommand(options: { directory?: string }): string {
  const changeDirectoryCommand = options.directory
    ? `cd ${quoteShell(options.directory)} || exit 1;`
    : "";

  return [
    changeDirectoryCommand,
    `COLORTERM=${quoteShell(DEFAULT_SSH_COLOR_TERM)};`,
    "export COLORTERM;",
    "if command -v tmux >/dev/null 2>&1; then",
    "exec tmux new-session \\; set-option destroy-unattached on;",
    "fi;",
    "shell=\"${SHELL:-/bin/sh}\";",
    "\"$shell\" -i",
  ].filter((part) => part.length > 0).join(" ");
}
