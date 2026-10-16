/**
 * Host-side ownership survives descendant process-group/session changes.
 */

export const CODE_PROCESS_WRAPPER = [
  "cleanup() {",
  '  trap "" HUP INT TERM',
  '  bash "$CLANKY_CODE_CLEANUP_FILE" "$CLANKY_CODE_PID_FILE"',
  "}",
  "trap 'status=$?; cleanup || exit 1; exit \"$status\"' EXIT",
  "trap 'exit 130' HUP INT TERM",
  'CLANKY_CODE_SESSION="$CLANKY_CODE_PID_FILE" "$@" &',
  "child=$!",
  'printf "%s\\n" "$child" > "$CLANKY_CODE_PID_FILE"',
  'wait "$child"',
].join("\n");

export const CODE_PROCESS_CLEANUP = [
  "set -o pipefail",
  'case "$(uname -s)" in Darwin) environment_flag="-Eww" ;; *) environment_flag="eww" ;; esac',
  'owner=$(id -u) || exit 71',
  'deadline=$((SECONDS + 4))',
  "while :; do",
  // The inherited marker also identifies reparented terminals and setsid jobs.
  '  owned=$(ps "$environment_flag" -U "$owner" -o pid=,stat=,command= | awk -v needle="CLANKY_CODE_SESSION=$1" \'index(" " $0 " ", " " needle " ") && $2 !~ /^Z/ {print $1}\' | sort -rn) || exit 71',
  '  [ -n "$owned" ] || exit 0',
  '  [ "$SECONDS" -lt "$deadline" ] || exit 72',
  '  for child in $owned; do',
  '    [[ "$child" =~ ^[1-9][0-9]*$ ]] || exit 73',
  '    kill -STOP "$child" 2>/dev/null || :',
  "  done",
  '  for child in $owned; do kill -KILL "$child" 2>/dev/null || :; done',
  "  sleep 0.05",
  "done",
].join("\n");
