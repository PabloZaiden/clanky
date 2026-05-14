/**
 * Shared shell bootstrap helpers used by SSH terminal startup commands.
 */

import { DEFAULT_SSH_COLOR_TERM, DEFAULT_SSH_TERM } from "./ssh-terminal-env";

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildShellBootstrapCommand(options: { directory?: string; useTmux?: boolean }): string {
  const changeDirectoryCommand = options.directory
    ? `cd ${quoteShell(options.directory)} || exit 1;`
    : "";
  const tmuxBootstrapCommands = options.useTmux === false
    ? []
    : [
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
      ];

  return [
    changeDirectoryCommand,
    "case \"${TERM:-}\" in ''|dumb|unknown) TERM=" + quoteShell(DEFAULT_SSH_TERM) + ";; esac;",
    "export TERM;",
    `COLORTERM=${quoteShell(DEFAULT_SSH_COLOR_TERM)};`,
    "export COLORTERM;",
    "shell=\"${SHELL:-/bin/sh}\";",
    ...tmuxBootstrapCommands,
    "exec \"$shell\" -i",
  ].filter((part) => part.length > 0).join(" ");
}
