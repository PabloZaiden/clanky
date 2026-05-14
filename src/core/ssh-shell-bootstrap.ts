/**
 * Shared shell bootstrap helpers used by SSH terminal startup commands.
 */

import {
  DEFAULT_SSH_COLOR_TERM,
  DEFAULT_SSH_TERM,
  DEFAULT_SSH_TERM_PROGRAM,
  DEFAULT_SSH_TERM_PROGRAM_VERSION,
  DEFAULT_SSH_UTF8_LOCALE,
} from "./ssh-terminal-env";

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
    `TERM_PROGRAM=${quoteShell(DEFAULT_SSH_TERM_PROGRAM)};`,
    "export TERM_PROGRAM;",
    `TERM_PROGRAM_VERSION=${quoteShell(DEFAULT_SSH_TERM_PROGRAM_VERSION)};`,
    "export TERM_PROGRAM_VERSION;",
    "case \"${LANG:-}\" in ''|C|POSIX) LANG=" + quoteShell(DEFAULT_SSH_UTF8_LOCALE) + ";; esac;",
    "export LANG;",
    "case \"${LC_CTYPE:-}\" in ''|C|POSIX) LC_CTYPE=\"$LANG\";; esac;",
    "export LC_CTYPE;",
    "shell=\"${SHELL:-/bin/sh}\";",
    ...tmuxBootstrapCommands,
    "exec \"$shell\" -i",
  ].filter((part) => part.length > 0).join(" ");
}
