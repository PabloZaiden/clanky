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
    "shell=\"${SHELL:-/bin/sh}\";",
    "if command -v tmux >/dev/null 2>&1; then",
    "tmux new-session \\; set-option destroy-unattached on;",
    "tmux_status=$?;",
    "if [ \"$tmux_status\" -eq 0 ]; then",
    "exit 0;",
    "fi;",
    "tmux new-session;",
    "tmux_status=$?;",
    "if [ \"$tmux_status\" -eq 0 ]; then",
    "exit 0;",
    "fi;",
    "fi;",
    "exec \"$shell\" -i",
  ].filter((part) => part.length > 0).join(" ");
}
