/**
 * Minimal container-owned worker loop; installation is owned by the launcher.
 */

import { shellQuote, type WorkerPaths } from "./worker-assets";

export function buildWorkerSupervisor(paths: WorkerPaths): string {
  return `#!/bin/sh
set -eu
root=${shellQuote(paths.containerRoot)}
binary=${shellQuote(paths.containerBinary)}
data_dir=${shellQuote(paths.containerData)}
script=${shellQuote(paths.containerSupervisor)}
log_file=${shellQuote(paths.containerLog)}
pid_file=${shellQuote(paths.containerPid)}
supervisor_pid_file="$root/supervisor.pid"
stop_file="$root/stopped"

alive() {
  [ -s "$1" ] || return 1
  if ! pid=$(cat "$1" 2>/dev/null); then
    [ ! -e "$1" ] && return 1
    echo "Cannot read worker process identity from $1." >&2
    exit 1
  fi
  case "$pid" in ""|*[!0-9]*|0|1) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    command_line=$(tr '\\000' ' ' <"/proc/$pid/cmdline")
    case "$command_line" in *"$2"*) ;; *) return 1 ;; esac
  fi
}

terminate() {
  if kill -TERM "$1" 2>/dev/null; then return 0; fi
  if kill -0 "$1" 2>/dev/null; then
    echo "Cannot terminate worker process $1." >&2
    return 1
  fi
  return 0
}

running() {
  [ ! -e "$stop_file" ] && alive "$supervisor_pid_file" "$script" && alive "$pid_file" "$binary"
}

stop_child() {
  if alive "$pid_file" "$binary"; then
    child_pid=$pid
    terminate "$child_pid"
    attempts=0
    while alive "$pid_file" "$binary" && [ "$attempts" -lt 50 ]; do
      sleep 0.1
      attempts=$((attempts + 1))
    done
    if alive "$pid_file" "$binary"; then
      echo "Worker did not stop within 5 seconds; terminating it." >&2
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  fi
}

case "\${1:-start}" in
  status)
    is_running=false
    if running; then is_running=true; fi
    printf '{"installed":true,"running":%s,"supervisor":"workspace-loop"}\\n' "$is_running"
    ;;
  restart)
    running || { echo "The workspace worker loop is not running." >&2; exit 1; }
    terminate "$pid"
    printf '{"operation":"restart","supervisor":"workspace-loop"}\\n'
    ;;
  stop)
    : >"$stop_file"
    if alive "$supervisor_pid_file" "$script"; then
      supervisor_pid=$pid
      terminate "$supervisor_pid"
      attempts=0
      while alive "$supervisor_pid_file" "$script" && [ "$attempts" -lt 100 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
      done
      if alive "$supervisor_pid_file" "$script"; then
        echo "The workspace worker loop did not stop within 10 seconds." >&2
        exit 1
      fi
    else
      stop_child
      rm -f "$pid_file"
    fi
    printf '{"operation":"stop","supervisor":"workspace-loop"}\\n'
    ;;
  start)
    command -v flock >/dev/null || { echo "The workspace worker loop requires flock (util-linux)." >&2; exit 1; }
    if running; then exit 0; fi
    if alive "$supervisor_pid_file" "$script"; then
      echo "The workspace worker loop is still starting or stopping." >&2
      exit 1
    fi
    if alive "$pid_file" "$binary"; then
      echo "A workspace worker is still running without its loop. Run supervisor.sh stop before starting it again." >&2
      exit 1
    fi
    rm -f "$stop_file"
    nohup sh "$script" run </dev/null >>"$log_file" 2>&1 &
    attempts=0
    until running; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 100 ]; then
        echo "The workspace worker loop did not start; check $log_file." >&2
        exit 1
      fi
      sleep 0.1
    done
    ;;
  run)
    exec 9>"$root/supervisor.lock"
    flock -n 9 || exit 0
    printf '%s\\n' "$$" >"$supervisor_pid_file"
    stopping=false
    child=""
    cleanup() {
      trap - EXIT
      stop_child
      if [ -n "$child" ]; then wait "$child" 2>/dev/null || true; fi
      rm -f "$pid_file" "$supervisor_pid_file"
    }
    trap cleanup EXIT
    trap 'stopping=true; : >"$stop_file"; if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi' TERM INT HUP
    export CLANKY_DATA_DIR="$data_dir"
    export CLANKY_WORKER_SUPERVISOR="$script"
    export CLANKY_WORKER_SUPERVISOR_STOP_FILE="$stop_file"
    export PATH="$root/bin:$root/runtime/bin:$PATH"
    restart_delay=1
    while [ "$stopping" = false ] && [ ! -e "$stop_file" ]; do
      started=$(date +%s)
      "$binary" serve 9>&- &
      child=$!
      printf '%s\\n' "$child" >"$pid_file"
      exit_code=0
      wait "$child" || exit_code=$?
      if [ "$stopping" = true ]; then break; fi
      rm -f "$pid_file"
      child=""
      [ ! -e "$stop_file" ] || break
      if [ $(($(date +%s) - started)) -ge 5 ]; then
        restart_delay=1
      fi
      echo "Worker exited with code $exit_code; restarting in $restart_delay seconds."
      remaining=$restart_delay
      while [ "$remaining" -gt 0 ] && [ "$stopping" = false ] && [ ! -e "$stop_file" ]; do
        sleep 1
        remaining=$((remaining - 1))
      done
      restart_delay=$((restart_delay * 2))
      if [ "$restart_delay" -gt 30 ]; then restart_delay=30; fi
    done
    ;;
  *)
    echo "Unsupported workspace worker loop operation: $1" >&2
    exit 1
    ;;
esac
`;
}
