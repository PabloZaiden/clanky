# Mesh worker

A Mesh worker is a headless Clanky process that exposes execution transports to
one or more independent controllers. It has no browser application, passkeys,
device authorization, peer roster, or controller-to-controller membership.
Each controller receives its own durable grant. Connectivity is checked only
when an operation runs; a network failure never revokes the grant.

Mesh, SSH, and local stdio targets all provide unrestricted access to their
host by design.

## Bootstrap

Create the worker owner and its API key in an empty data directory:

```bash
CLANKY_DATA_DIR=/app/data \
clanky worker bootstrap --username worker
```

The plaintext `apiKey` is returned only on creation. Use `--rotate` to replace
the managed key.

## Start manually

```bash
CLANKY_DATA_DIR=/app/data \
clanky serve --mesh-worker true --worker-directory /workspaces
```

`worker-directory` is worker-owned and is never remotely configurable. Its
precedence is startup flag, `CLANKY_WORKER_DIRECTORY`, persisted serve config,
then the process working directory. Both options can be persisted:

```bash
CLANKY_DATA_DIR=/app/data clanky serve config set mesh-worker true
CLANKY_DATA_DIR=/app/data clanky serve config set worker-directory /workspaces
```

Remote execution is enabled by default. Disable this worker as an execution
target without revoking its controller grants with
`--worker-execution-enabled false`,
`CLANKY_WORKER_EXECUTION_ENABLED=false`, or the equivalent persisted serve
option. The worker advances its persisted configuration revision whenever its
resolved directory or execution policy changes. Each controller health probe
verifies the worker's signed response and synchronizes the newer snapshot into
that controller's execution-host registration.

## Register as an operating-system service

The service command requires the standalone `clanky` binary and an already
initialized worker data directory. It does not bootstrap, enroll, move, or
delete worker data.

```bash
CLANKY_DATA_DIR=/app/data clanky worker service install
clanky worker service status
```

On macOS this installs a per-user LaunchAgent that starts at login through
`/bin/zsh -lic`, so the worker inherits the user's normal Terminal setup,
including PATH, SSH agent, Keychain-backed tools, GitHub CLI, and Copilot
configuration. On Linux this installs a systemd service that starts at boot
as the current user and waits for the network.

To regenerate the service configuration without starting it immediately, use
`clanky worker service install --no-start`. The lifecycle commands are:

```bash
clanky worker service start
clanky worker service stop
clanky worker service restart
clanky worker service uninstall
```

Set the public endpoint and optional display name using the bootstrap API key:

```bash
export CLANKY_BASE_URL=https://worker.example.com
export CLANKY_API_KEY=<worker-api-key>

clanky api mesh/endpoint --method POST \
  --payload '{"meshEndpoint":"https://worker.example.com"}'
clanky api mesh/instance-name --method POST \
  --payload '{"instanceName":"worker-1"}'
```

## Enroll with a controller

Create a single-use token on the controller:

```bash
CLANKY_BASE_URL=https://controller.example.com \
CLANKY_API_KEY=<controller-api-key> \
clanky mesh enrollment-token create --name worker-1
```

Then enroll from the worker:

```bash
clanky mesh enroll https://controller.example.com \
  --token <single-use-token> \
  --fingerprint <controller-fingerprint>
```

Repeat these two steps for every controller that should use the worker.
Controllers do not learn about each other, and the worker status reports only
the number of active controller grants.

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
