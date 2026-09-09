# Mesh worker

A Mesh worker is a headless Clanky process that exposes execution transports to
one or more independent controllers. It has no browser application, passkeys,
device authorization, peer roster, or controller-to-controller membership.
Each controller receives its own durable grant. Connectivity is checked only
when an operation runs; a network failure never revokes the grant.

Mesh, SSH, and local stdio targets all provide unrestricted access to their
host by design.

## Bootstrap

Run this on the host that will execute workspaces. The data directory defaults
to `$HOME/.clanky`; set `CLANKY_DATA_DIR` only when the worker should use a
different location:

```bash
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint https://worker.example.com
```

`--host` controls the local interface where the worker listens. For a worker
that production reaches directly, use `0.0.0.0` (or the host's reachable
interface), allow or forward the selected port through the firewall/NAT, and
set `--mesh-endpoint` to a public DNS name or a stable reachable IP. If there
is no public DNS name, include the port in the endpoint, which is the common
direct-worker setup:

```bash
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint https://203.0.113.10:3000
```

Do not use `127.0.0.1`, `localhost`, or a private address that production
cannot route to. Workers use HTTPS by default and generate a durable
self-signed certificate in their data directory. The controller pins that
certificate during enrollment, including for HTTP and WebSocket requests.

HTTP is available only as an explicit opt-out for a trusted private network:

```bash
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint http://203.0.113.10:3000 \
  --insecure
```

The bootstrap persists the host, port, worker directory, Mesh endpoint, worker
mode, instance name, and worker identity. The worker username is fixed
internally. The plaintext `apiKey` is returned only on creation or rotation;
keep it on the worker if administrative API access is needed, but the join
command does not need it.
Mesh execution resolves relative directories and paths against the configured
worker directory; absolute paths are used directly.

To replace a lost key or intentionally rotate the worker certificate, repeat
the same command with `--rotate`. The old key is revoked and the new plaintext
key is printed once. Certificate rotation changes the worker's pinned identity,
so enroll the worker again with each controller after rotating it.

```bash
CLANKY_DATA_DIR=/srv/clanky-worker \
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint https://worker.example.com
```

Remote execution is enabled by default. Disable this worker as an execution
target without revoking its controller grants through the worker's persisted
serve configuration. The worker advances its persisted configuration revision
whenever its resolved directory or execution policy changes. Each controller
health probe verifies the worker's signed response and synchronizes the newer
snapshot into that controller's execution-host registration.

## Register as an operating-system service

The service command requires the standalone `clanky` binary and an already
initialized worker data directory. It does not bootstrap, enroll, move, or
delete worker data.

```bash
clanky worker service install
clanky worker service status
```

If `CLANKY_DATA_DIR` was used for bootstrap, use the same value for the service
command:

```bash
CLANKY_DATA_DIR=/srv/clanky-worker clanky worker service install
```

On macOS, the per-user LaunchAgent starts at login through `/bin/zsh -lic`.
The worker process starts its permission preflight asynchronously: it requests
Accessibility, Screen Recording, and direct screen capture access for
screenshots. The preflight also performs one non-interactive `screencapture`
probe so macOS can show its screen/audio capture consent before an agent needs
a screenshot, then probes Desktop, Documents, and Downloads for Files and
Folders access. Mesh starts serving immediately and continues working if a
prompt is denied, ignored, or times out; failures are logged. This keeps the
consent associated with the service process rather than the terminal used to
install it. Full Disk Access is not requested by this command. On Linux this
installs a systemd service that starts at boot as the current user and waits
for the network.

To regenerate the service configuration without starting it immediately, use
`clanky worker service install --no-start`. The lifecycle commands are:

```bash
clanky worker service start
clanky worker service stop
clanky worker service restart
clanky worker service uninstall
```

When `--no-start` is used on macOS, run `clanky worker service start` from the
logged-in user session to start the worker and trigger its non-blocking
permission preflight.

## Enroll with a controller

Create a single-use token on the controller:

```bash
clanky mesh enrollment-token create --name worker-1
```

The JSON response includes `response.workerJoinCommand`. Copy that complete
one-line string and run it on the worker:

```bash
clanky worker join --controller 'https://controller.example.com' --token '<single-use-token>' --fingerprint '<controller-fingerprint>'
```

The generated command uses the worker's local identity and does not require
copying the worker API key, `CLANKY_BASE_URL`, or other local environment
variables. Repeat token creation and the generated join command for every
controller that should use the worker. The controller endpoint must be
configured and reachable by the worker before creating the token.

Verify the enrollment on the controller:

```bash
clanky mesh status
```

Controllers do not learn about each other, and the worker status reports only
the number of active controller grants.

From the controller's **Settings > Mesh > Workers** list, use **Kill** to send
a signed termination command to an active worker. The worker acknowledges the
request, exits its process, and leaves the LaunchAgent or systemd supervisor
to restart it. Killing a worker does not revoke its Mesh grant; use **Revoke**
when the controller should stop trusting that worker.

## Operations

On a controller:

```bash
clanky mesh status
clanky mesh revoke <worker-node-id>
```

Worker updates are local operations managed by the operating system service.
After installing a newer standalone binary, run:

```bash
clanky update
clanky worker service restart
```

The service supervisor stops the current foreground worker and starts the new
binary with the registered worker configuration. No worker data or Mesh
identity is moved during an update.

Direct chats created on a Mesh server use the normal provider and model
selection. Provider and model defaults are not stored on the worker.

## Upgrade from the peer Mesh

Database migration 45 is an intentional clean break. It deletes the previous
Mesh identity, peer records, Mesh execution hosts, local hosts bound to that
identity, and all dependent workspaces, tasks, chats, agents, sessions,
terminals, provisioning jobs, VNC sessions, transcripts, and context API-key
bindings. It does not remap legacy data to controller-worker registrations.
Unrelated SSH hosts and their data are preserved.
