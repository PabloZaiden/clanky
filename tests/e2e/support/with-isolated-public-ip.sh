set -eu

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

exec "$@"
