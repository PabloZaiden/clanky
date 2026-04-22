/**
 * Shared helpers for persistent SSH sessions backed by dtach.
 */

import { buildShellBootstrapCommand } from "./ssh-shell-bootstrap";

const DTACH_INSTALL_HINT = [
  "dtach is not available on the remote host.",
  "Ralpher switched this session to Direct SSH.",
  "Install dtach on Linux with your package manager",
  "(for example: sudo apt install dtach, sudo dnf install dtach, or sudo pacman -S dtach)",
  "or on macOS with brew install dtach.",
].join(" ");

export interface PersistentSshSessionConfigLike {
  id: string;
  remoteSessionName: string;
  directory?: string;
  useTmux?: boolean;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildPersistentSessionSocketPath(remoteSessionName: string): string {
  return `/tmp/${remoteSessionName}.dtach.sock`;
}

function buildPersistentSessionClientTtyFilePath(sessionId: string): string {
  return `/tmp/ralpher-terminal-${sessionId}.tty`;
}

function buildPersistentSessionTtyFilePath(sessionId: string): string {
  return `/tmp/ralpher-terminal-${sessionId}.session.tty`;
}

function buildPersistentSessionPidFilePath(sessionId: string): string {
  return `/tmp/ralpher-terminal-${sessionId}.pid`;
}

function buildPersistentSessionMasterPidFilePath(sessionId: string): string {
  return `/tmp/ralpher-terminal-${sessionId}.master.pid`;
}

function buildPersistentSessionShellCommand(session: { config: PersistentSshSessionConfigLike }): string {
  const sessionTtyFile = quoteShell(buildPersistentSessionTtyFilePath(session.config.id));
  const sessionPidFile = quoteShell(buildPersistentSessionPidFilePath(session.config.id));
  const sessionMasterPidFile = quoteShell(buildPersistentSessionMasterPidFilePath(session.config.id));
  const sessionSocket = quoteShell(buildPersistentSessionSocketPath(session.config.remoteSessionName));
  return [
    `session_tty_file=${sessionTtyFile}`,
    `session_pid_file=${sessionPidFile}`,
    `session_master_pid_file=${sessionMasterPidFile}`,
    `session_socket=${sessionSocket}`,
    "session_tty_path=$(tty);",
    "if [ -z \"$session_tty_path\" ] || [ \"$session_tty_path\" = \"not a tty\" ]; then",
    "echo 'Failed to determine persistent session tty.' >&2;",
    "exit 1;",
    "fi;",
    "printf '%s\\n' \"$session_tty_path\" > \"$session_tty_file\";",
    "printf '%s\\n' \"$$\" > \"$session_pid_file\";",
    "cleanup_session() { rm -f \"$session_tty_file\" \"$session_pid_file\" \"$session_master_pid_file\" \"$session_socket\"; };",
    "trap cleanup_session EXIT HUP INT TERM;",
    buildShellBootstrapCommand({
      directory: session.config.directory,
      useTmux: session.config.useTmux,
    }),
  ].filter((part) => part.length > 0).join(" ");
}

export function buildPersistentSessionAttachCommand(session: { config: PersistentSshSessionConfigLike }): string {
  const clientTtyFile = quoteShell(buildPersistentSessionClientTtyFilePath(session.config.id));
  const sessionTtyFile = quoteShell(buildPersistentSessionTtyFilePath(session.config.id));
  const sessionPidFile = quoteShell(buildPersistentSessionPidFilePath(session.config.id));
  const sessionMasterPidFile = quoteShell(buildPersistentSessionMasterPidFilePath(session.config.id));
  const sessionSocket = quoteShell(buildPersistentSessionSocketPath(session.config.remoteSessionName));
  const sessionShellCommand = quoteShell(buildPersistentSessionShellCommand(session));
  return [
    "if ! command -v dtach >/dev/null 2>&1; then",
    "echo 'dtach is not installed on the remote host.' >&2;",
    "exit 127;",
    "fi;",
    `client_tty_file=${clientTtyFile}`,
    `session_tty_file=${sessionTtyFile}`,
    `session_pid_file=${sessionPidFile}`,
    `session_master_pid_file=${sessionMasterPidFile}`,
    `session_socket=${sessionSocket}`,
    "is_live_pid_file() {",
    "pid_file=$1",
    "if [ ! -r \"$pid_file\" ]; then",
    "return 1",
    "fi",
    "pid=$(cat \"$pid_file\" 2>/dev/null || true)",
    "case \"$pid\" in",
    "''|*[!0-9]*) return 1 ;;",
    "esac",
    "kill -0 \"$pid\" 2>/dev/null",
    "}",
    "terminate_stale_session() {",
    "master_pid_file=$1",
    "shell_pid_file=$2",
    "if is_live_pid_file \"$master_pid_file\"; then",
    "mpid=$(cat \"$master_pid_file\" 2>/dev/null || true)",
    "kill \"$mpid\" 2>/dev/null || true",
    "fi",
    "if is_live_pid_file \"$shell_pid_file\"; then",
    "spid=$(cat \"$shell_pid_file\" 2>/dev/null || true)",
    "wait_count=0",
    "while kill -0 \"$spid\" 2>/dev/null && [ \"$wait_count\" -lt 10 ]; do",
    "sleep 0.1",
    "wait_count=$((wait_count + 1))",
    "done",
    "if kill -0 \"$spid\" 2>/dev/null; then",
    "kill -9 \"$spid\" 2>/dev/null || true",
    "fi",
    "fi",
    "if is_live_pid_file \"$master_pid_file\"; then",
    "mpid=$(cat \"$master_pid_file\" 2>/dev/null || true)",
    "kill -9 \"$mpid\" 2>/dev/null || true",
    "fi",
    "}",
    "client_tty_path=$(tty);",
    "if [ -z \"$client_tty_path\" ] || [ \"$client_tty_path\" = \"not a tty\" ]; then",
    "echo 'Failed to determine remote SSH tty.' >&2;",
    "exit 1;",
    "fi;",
    "printf '%s\\n' \"$client_tty_path\" > \"$client_tty_file\";",
    "cleanup_client_tty() { rm -f \"$client_tty_file\"; };",
    "trap cleanup_client_tty EXIT HUP INT TERM;",
    "if [ -S \"$session_socket\" ] && ! is_live_pid_file \"$session_master_pid_file\"; then",
    "rm -f \"$session_socket\" \"$session_tty_file\" \"$session_pid_file\" \"$session_master_pid_file\";",
    "fi;",
    "if [ -S \"$session_socket\" ] && ! is_live_pid_file \"$session_pid_file\"; then",
    "rm -f \"$session_socket\" \"$session_tty_file\" \"$session_pid_file\" \"$session_master_pid_file\";",
    "fi;",
    "if [ ! -S \"$session_socket\" ]; then",
    "terminate_stale_session \"$session_master_pid_file\" \"$session_pid_file\"",
    "rm -f \"$session_tty_file\" \"$session_pid_file\" \"$session_master_pid_file\";",
    `dtach -N "$session_socket" -Ez bash -lc ${sessionShellCommand} &`,
    "session_master_pid=$!;",
    "printf '%s\\n' \"$session_master_pid\" > \"$session_master_pid_file\";",
    "fi;",
    "wait_attempt=0",
    "while [ ! -S \"$session_socket\" ] && [ \"$wait_attempt\" -lt 50 ]; do",
    "sleep 0.1",
    "wait_attempt=$((wait_attempt + 1))",
    "done",
    "if [ ! -S \"$session_socket\" ]; then",
    "echo 'Persistent SSH session socket was not created.' >&2;",
    "exit 1;",
    "fi;",
    "dtach -a \"$session_socket\" -E -z -r winch",
  ].join("\n");
}

export function buildPersistentSessionReadyCommand(session: {
  config: Pick<PersistentSshSessionConfigLike, "id" | "remoteSessionName">;
}): string {
  const sessionTtyFile = quoteShell(buildPersistentSessionTtyFilePath(session.config.id));
  const sessionPidFile = quoteShell(buildPersistentSessionPidFilePath(session.config.id));
  const sessionMasterPidFile = quoteShell(buildPersistentSessionMasterPidFilePath(session.config.id));
  const sessionSocket = quoteShell(buildPersistentSessionSocketPath(session.config.remoteSessionName));
  return [
    `session_tty_file=${sessionTtyFile}`,
    `session_pid_file=${sessionPidFile}`,
    `session_master_pid_file=${sessionMasterPidFile}`,
    `session_socket=${sessionSocket}`,
    "require_live_pid_file() {",
    "pid_file=$1",
    "if [ ! -r \"$pid_file\" ]; then",
    "return 1",
    "fi",
    "pid=$(cat \"$pid_file\" 2>/dev/null || true)",
    "case \"$pid\" in",
    "''|*[!0-9]*) return 1 ;;",
    "esac",
    "kill -0 \"$pid\" 2>/dev/null",
    "}",
    "if [ ! -S \"$session_socket\" ] || [ ! -r \"$session_tty_file\" ]; then",
    "exit 1;",
    "fi;",
    "if ! require_live_pid_file \"$session_pid_file\" || ! require_live_pid_file \"$session_master_pid_file\"; then",
    "exit 1;",
    "fi;",
    "session_tty_path=$(cat \"$session_tty_file\" 2>/dev/null || true);",
    "[ -n \"$session_tty_path\" ]",
  ].join("\n");
}

export function buildPersistentSessionResizeCommand(sessionId: string, cols: number, rows: number): string {
  const clientTtyFile = quoteShell(buildPersistentSessionClientTtyFilePath(sessionId));
  const sessionTtyFile = quoteShell(buildPersistentSessionTtyFilePath(sessionId));
  return [
    `client_tty_file=${clientTtyFile}`,
    `session_tty_file=${sessionTtyFile}`,
    `cols=${String(cols)}`,
    `rows=${String(rows)}`,
    "resize_tty() {",
    "tty_file=$1",
    "tty_label=$2",
    "if [ ! -r \"$tty_file\" ]; then",
    "echo \"$tty_label tty is not ready\" >&2",
    "return 1",
    "fi",
    "tty_path=$(cat \"$tty_file\" 2>/dev/null || true)",
    "if [ -z \"$tty_path\" ]; then",
    "echo \"$tty_label tty is not ready\" >&2",
    "return 1",
    "fi",
    "stty cols \"$cols\" rows \"$rows\" < \"$tty_path\"",
    "}",
    "resize_tty \"$session_tty_file\" 'Persistent session';",
    "if [ -r \"$client_tty_file\" ]; then",
    "resize_tty \"$client_tty_file\" 'Attach client' >/dev/null 2>&1 || true",
    "fi",
  ].join("\n");
}

export function buildPersistentSessionDeleteCommand(session: {
  config: Pick<PersistentSshSessionConfigLike, "id" | "remoteSessionName">;
}): string {
  const clientTtyFile = quoteShell(buildPersistentSessionClientTtyFilePath(session.config.id));
  const sessionTtyFile = quoteShell(buildPersistentSessionTtyFilePath(session.config.id));
  const sessionPidFile = quoteShell(buildPersistentSessionPidFilePath(session.config.id));
  const sessionMasterPidFile = quoteShell(buildPersistentSessionMasterPidFilePath(session.config.id));
  const sessionSocket = quoteShell(buildPersistentSessionSocketPath(session.config.remoteSessionName));
  return [
    `client_tty_file=${clientTtyFile}`,
    `session_tty_file=${sessionTtyFile}`,
    `session_pid_file=${sessionPidFile}`,
    `session_master_pid_file=${sessionMasterPidFile}`,
    `session_socket=${sessionSocket}`,
    "read_pid_file() {",
    "pid_file=$1",
    "if [ ! -r \"$pid_file\" ]; then",
    "return 1",
    "fi",
    "pid=$(cat \"$pid_file\" 2>/dev/null || true)",
    "case \"$pid\" in",
    "''|*[!0-9]*) return 1 ;;",
    "esac",
    "echo \"$pid\"",
    "return 0",
    "}",
    "master_pid=$(read_pid_file \"$session_master_pid_file\")",
    "shell_pid=$(read_pid_file \"$session_pid_file\")",
    // Kill dtach master to close the PTY master fd. This triggers SIGHUP to
    // the session leader (the shell), which propagates SIGHUP to all its jobs
    // — the same cascade that happens when an SSH connection drops.
    "if [ -n \"$master_pid\" ] && kill -0 \"$master_pid\" 2>/dev/null; then",
    "kill \"$master_pid\" 2>/dev/null || true",
    "fi",
    // Wait for the shell to exit via the SIGHUP cascade (up to 2s).
    "if [ -n \"$shell_pid\" ] && kill -0 \"$shell_pid\" 2>/dev/null; then",
    "wait_count=0",
    "while kill -0 \"$shell_pid\" 2>/dev/null && [ \"$wait_count\" -lt 20 ]; do",
    "sleep 0.1",
    "wait_count=$((wait_count + 1))",
    "done",
    // SIGKILL the shell as a last resort if it survived the SIGHUP.
    "if kill -0 \"$shell_pid\" 2>/dev/null; then",
    "kill -9 \"$shell_pid\" 2>/dev/null || true",
    "fi",
    "fi",
    // SIGKILL dtach master if it is still alive.
    "if [ -n \"$master_pid\" ] && kill -0 \"$master_pid\" 2>/dev/null; then",
    "kill -9 \"$master_pid\" 2>/dev/null || true",
    "fi",
    "rm -f \"$client_tty_file\" \"$session_tty_file\" \"$session_pid_file\" \"$session_master_pid_file\" \"$session_socket\"",
  ].join("\n");
}

export function buildPersistentSessionBackendProbeCommand(): string {
  return "command -v dtach >/dev/null 2>&1 && dtach --help >/dev/null 2>&1";
}

export function buildPersistentSessionBackendInstallHint(): string {
  return DTACH_INSTALL_HINT;
}
