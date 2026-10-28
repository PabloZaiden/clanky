set -eu

test_uid=$1
test_gid=$2
shift 2

case "$test_uid" in
  ''|*[!0-9]*)
    echo "The E2E process UID must be numeric." >&2
    exit 1
    ;;
esac
case "$test_gid" in
  ''|*[!0-9]*)
    echo "The E2E process GID must be numeric." >&2
    exit 1
    ;;
esac
if [ "$1" != "--" ]; then
  echo "Expected the isolated E2E command separator." >&2
  exit 1
fi
shift

# This address exists only on loopback inside the caller's isolated namespace.
ip link set lo up
ip address add 1.1.1.1/32 dev lo

if [ "$(ip -o link show | wc -l)" -ne 1 ]; then
  echo "The public-IP fixture namespace must contain only loopback." >&2
  exit 1
fi

if ip route show default | grep -q .; then
  echo "The public-IP fixture namespace must not have a default route." >&2
  exit 1
fi

if [ "$test_uid" -ne 0 ] || [ "$test_gid" -ne 0 ]; then
  exec setpriv --reuid "$test_uid" --regid "$test_gid" --init-groups -- "$@"
fi
exec "$@"
