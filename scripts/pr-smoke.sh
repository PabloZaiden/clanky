#!/usr/bin/env bash

set -Eeuo pipefail

HEALTH_ATTEMPTS=30
HEALTH_INTERVAL_SECONDS=1
PORT=""
BASE_URL=""
LOG_FILE="/tmp/clanky-pr-smoke.log"
CHECK_ONLY=false
ENV_ARGS=()
COMMAND=()
APP_PID=""
TEMP_DIR=""
LAST_BODY=""
RESOURCE_INDEX=0

usage() {
  cat <<'EOF'
Usage:
  scripts/pr-smoke.sh [options] -- command [args...]
  scripts/pr-smoke.sh --check-only [options]

Options:
  --port PORT             Port used to build the default base URL.
  --base-url URL          Base URL to check instead of the default localhost URL.
  --log-file PATH         File that captures a locally started command's output.
  --env NAME=VALUE        Environment variable passed to a locally started command.
  --check-only            Check an already-running target without starting a command.
  --help                  Show this help.
EOF
}

fail() {
  local message="$1"
  echo "PR smoke check failed: ${message}" >&2
  if [[ -n "$LOG_FILE" && -f "$LOG_FILE" ]]; then
    echo "--- captured process log: ${LOG_FILE} ---" >&2
    cat "$LOG_FILE" >&2
    echo "--- end captured process log ---" >&2
  fi
  exit 1
}

cleanup() {
  local exit_code="$?"
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
  exit "$exit_code"
}

normalize_url() {
  local path="$1"
  case "$path" in
    http://*|https://*)
      printf '%s\n' "$path"
      ;;
    /*)
      printf '%s%s\n' "$BASE_URL" "$path"
      ;;
    ./*)
      printf '%s/%s\n' "$BASE_URL" "${path#./}"
      ;;
    *)
      printf '%s/%s\n' "$BASE_URL" "$path"
      ;;
  esac
}

content_type_for_headers() {
  local content_type
  content_type="$(grep -i '^content-type:' "$1" | tail -n 1 || true)"
  printf '%s\n' "$content_type" \
    | cut -d ':' -f 2- \
    | tr -d '\r' \
    | sed -E 's/^[[:space:]]*//' \
    | cut -d ';' -f 1 \
    | tr '[:upper:]' '[:lower:]'
}

fetch_resource() {
  local label="$1"
  local path="$2"
  local url
  local body_path
  local headers_path

  url="$(normalize_url "$path")"
  body_path="${TEMP_DIR}/body-${RESOURCE_INDEX}"
  headers_path="${TEMP_DIR}/headers-${RESOURCE_INDEX}"
  RESOURCE_INDEX=$((RESOURCE_INDEX + 1))

  if ! curl --fail --silent --show-error \
    --dump-header "$headers_path" \
    --output "$body_path" \
    "$url"; then
    fail "${label} reference ${path} was not retrievable (${url})"
  fi

  LAST_BODY="$body_path"
  CONTENT_TYPE="$(content_type_for_headers "$headers_path")"
  if [[ -z "$CONTENT_TYPE" ]]; then
    fail "${label} reference ${path} did not provide a Content-Type header (${url})"
  fi
  echo "Checked ${label}: ${path} (${CONTENT_TYPE})"
}

require_content_type() {
  local label="$1"
  local expected="$2"
  if [[ "$CONTENT_TYPE" != "$expected" ]]; then
    fail "${label} returned Content-Type ${CONTENT_TYPE}, expected ${expected}"
  fi
}

require_javascript_content_type() {
  local label="$1"
  case "$CONTENT_TYPE" in
    application/javascript|application/x-javascript|text/javascript)
      ;;
    *)
      fail "${label} returned non-JavaScript Content-Type ${CONTENT_TYPE}"
      ;;
  esac
}

require_image_content_type() {
  local label="$1"
  if [[ "$CONTENT_TYPE" != image/* ]]; then
    fail "${label} returned non-image Content-Type ${CONTENT_TYPE}"
  fi
}

wait_for_health() {
  local health_url="${BASE_URL}/api/health"
  local attempt

  for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if [[ -n "$APP_PID" ]] && ! kill -0 "$APP_PID" 2>/dev/null; then
      fail "the application exited during startup"
    fi
    if curl --fail --silent --show-error "$health_url" >/dev/null; then
      echo "Application became ready at ${BASE_URL}"
      return
    fi
    if [[ "$attempt" -eq "$HEALTH_ATTEMPTS" ]]; then
      fail "the application did not become ready at ${health_url}"
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
}

check_html_assets() {
  local html
  local tag
  local href
  local rel
  local manifest_body=""
  local path
  local manifest_path
  local icon_path
  local -a javascript_paths=()
  local -a stylesheet_paths=()
  local -a manifest_paths=()
  local -a icon_paths=()
  local -a manifest_icon_paths=()

  fetch_resource "HTML document" "/"
  require_content_type "HTML document" "text/html"
  html="$(tr '\n' ' ' < "$LAST_BODY")"

  mapfile -t javascript_paths < <(
    printf '%s' "$html" \
      | grep -oE 'src="[^"]+\.js([?#][^"]*)?"' \
      | sed -E 's/^src="([^"]+)".*$/\1/' \
      || true
  )
  mapfile -t stylesheet_paths < <(
    printf '%s' "$html" \
      | grep -oE 'href="[^"]+\.css([?#][^"]*)?"' \
      | sed -E 's/^href="([^"]+)".*$/\1/' \
      || true
  )

  if [[ "${#javascript_paths[@]}" -eq 0 ]]; then
    fail "the HTML document did not reference a JavaScript asset"
  fi
  if [[ "${#stylesheet_paths[@]}" -eq 0 ]]; then
    fail "the HTML document did not reference a CSS asset"
  fi

  for path in "${javascript_paths[@]}"; do
    fetch_resource "JavaScript asset" "$path"
    require_javascript_content_type "JavaScript asset ${path}"
  done
  for path in "${stylesheet_paths[@]}"; do
    fetch_resource "CSS asset" "$path"
    require_content_type "CSS asset ${path}" "text/css"
  done

  mapfile -t tag < <(printf '%s' "$html" | grep -oiE '<link[^>]*>' || true)
  for tag in "${tag[@]}"; do
    href="$(
      printf '%s' "$tag" \
        | grep -oiE 'href="[^"]+"' \
        | head -n 1 \
        | sed -E 's/^href="([^"]+)".*$/\1/' \
        || true
    )"
    rel="$(
      printf '%s' "$tag" \
        | grep -oiE 'rel="[^"]+"' \
        | head -n 1 \
        | sed -E 's/^rel="([^"]+)".*$/\1/' \
        || true
    )"
    if [[ -z "$href" ]]; then
      continue
    fi
    rel="${rel,,}"
    if [[ "$rel" == *manifest* ]]; then
      manifest_paths+=("$href")
    elif [[ "$rel" == *icon* ]]; then
      icon_paths+=("$href")
    fi
  done

  for manifest_path in "${manifest_paths[@]}"; do
    fetch_resource "Web manifest" "$manifest_path"
    require_content_type "Web manifest ${manifest_path}" "application/manifest+json"
    manifest_body="$LAST_BODY"
    mapfile -t manifest_icon_paths < <(
      grep -oE '"src"[[:space:]]*:[[:space:]]*"[^"]+"' "$manifest_body" \
        | sed -E 's/.*"src"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
        || true
    )
    for icon_path in "${manifest_icon_paths[@]}"; do
      fetch_resource "Manifest icon" "$icon_path"
      require_image_content_type "Manifest icon ${icon_path}"
    done
  done

  for icon_path in "${icon_paths[@]}"; do
    fetch_resource "HTML icon" "$icon_path"
    require_image_content_type "HTML icon ${icon_path}"
  done
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --port)
      [[ "$#" -ge 2 ]] || { usage >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --base-url)
      [[ "$#" -ge 2 ]] || { usage >&2; exit 2; }
      BASE_URL="$2"
      shift 2
      ;;
    --log-file)
      [[ "$#" -ge 2 ]] || { usage >&2; exit 2; }
      LOG_FILE="$2"
      shift 2
      ;;
    --env)
      [[ "$#" -ge 2 ]] || { usage >&2; exit 2; }
      ENV_ARGS+=("$2")
      shift 2
      ;;
    --check-only)
      CHECK_ONLY=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    --)
      shift
      COMMAND=("$@")
      break
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  if [[ -z "$PORT" ]]; then
    echo "--port or --base-url is required" >&2
    usage >&2
    exit 2
  fi
  BASE_URL="http://127.0.0.1:${PORT}"
fi
BASE_URL="${BASE_URL%/}"

if [[ "$CHECK_ONLY" == false && "${#COMMAND[@]}" -eq 0 ]]; then
  echo "a startup command is required unless --check-only is used" >&2
  usage >&2
  exit 2
fi
if [[ "$CHECK_ONLY" == true && "${#COMMAND[@]}" -gt 0 ]]; then
  echo "a startup command cannot be used with --check-only" >&2
  usage >&2
  exit 2
fi

TEMP_DIR="$(mktemp -d)"
trap cleanup EXIT

if [[ "$CHECK_ONLY" == false ]]; then
  : > "$LOG_FILE"
  env "${ENV_ARGS[@]}" "${COMMAND[@]}" >"$LOG_FILE" 2>&1 &
  APP_PID="$!"
fi

wait_for_health
check_html_assets
echo "PR smoke checks passed for ${BASE_URL}"
