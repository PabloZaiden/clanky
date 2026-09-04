# Mesh worker

A Mesh worker is a Clanky installation that exposes a restricted execution
surface instead of the browser application. It accepts signed Mesh transport
requests and the API-key-authenticated operations needed to configure and join
the node. The normal UI, passkeys, device authorization, realtime UI, and
unrelated Clanky APIs are disabled.

Mesh workers use the same Clanky binary and data directory as a full
installation. A paired worker grants the Mesh unrestricted command and file
access to its host by design. The node-level **Accept remote execution**
setting controls whether it can be selected as an execution target.

## 1. Bootstrap the worker

Choose an empty Clanky data directory and create the owner identity and managed
API key:

```bash
CLANKY_DATA_DIR=/app/data \
clanky worker bootstrap --username worker
```

The command prints one JSON object. Save its `apiKey` value; the plaintext key
is shown only when it is first created. Repeating the command is idempotent and
returns `apiKey: null` with the existing key ID. Pass `--rotate` to revoke the
managed worker key and generate a replacement.

## 2. Start the restricted server

Start the worker as a detached Clanky server:

```bash
CLANKY_DATA_DIR=/app/data \
clanky serve up --mesh-worker true
```

Foreground `clanky serve --mesh-worker true` accepts the same option. The
examples in this guide use `serve up` so the worker remains detached.

The same option can come from any lifecycle configuration surface:

```bash
# Environment
CLANKY_DATA_DIR=/app/data \
CLANKY_MESH_WORKER=true \
clanky serve up

# Persistent configuration
CLANKY_DATA_DIR=/app/data \
clanky serve config set mesh-worker true
CLANKY_DATA_DIR=/app/data \
clanky serve up
```

The precedence is invocation flag, environment variable, persisted
configuration, then the `false` default. A flag affects only that invocation
and does not rewrite `config.json`. Inspect persisted and effective values
with:

```bash
CLANKY_DATA_DIR=/app/data clanky serve config show
```

Use `--mesh-worker false`, `CLANKY_MESH_WORKER=false`, or
`serve config set mesh-worker false` at the corresponding precedence level to
run the full Clanky server instead.

## 3. Configure the node

Point the CLI at the running worker with the API key returned by bootstrap:

```bash
export CLANKY_BASE_URL=https://worker.example.com
export CLANKY_API_KEY=<worker-api-key>
```

Set the node name and the endpoint it advertises to other Mesh members:

```bash
clanky api mesh/instance-name \
  --method POST \
  --payload '{"instanceName":"worker-1"}'

clanky api mesh/endpoint \
  --method POST \
  --payload '{"meshEndpoint":"https://worker.example.com"}'
```

Enable the node as an execution target and optionally set its default
repositories directory:

```bash
clanky api mesh/execution \
  --method POST \
  --payload '{"acceptRemoteExecution":true,"repositoriesBasePath":"/workspaces"}'
```

Use `null` for `repositoriesBasePath` when the node should not advertise a
default directory. Setting `acceptRemoteExecution` to `false` keeps the node in
the Mesh but prevents it from serving as an execution target.

## 4. Create an enrollment token

Run this against an existing owner/controller installation:

```bash
export CLANKY_BASE_URL=https://controller.example.com
export CLANKY_API_KEY=<controller-api-key>

clanky mesh enrollment-token create \
  --name worker-1 \
  --ttl-seconds 900
```

The response contains the single-use `token` and
`enrollment.controllerFingerprint` required by the worker. The default
lifetime is 15 minutes.

## 5. Enroll the worker

Point the CLI back at the worker and submit the controller endpoint, token, and
fingerprint:

```bash
export CLANKY_BASE_URL=https://worker.example.com
export CLANKY_API_KEY=<worker-api-key>

clanky mesh enroll https://controller.example.com \
  --token <single-use-token> \
  --fingerprint <controller-fingerprint>
```

The token and fingerprint may instead be provided through
`CLANKY_MESH_ENROLLMENT_TOKEN` and
`CLANKY_MESH_CONTROLLER_FINGERPRINT`. Successful enrollment consumes the token
and completes membership without browser confirmation.

## 6. Verify the worker

Inspect the worker:

```bash
CLANKY_BASE_URL=https://worker.example.com \
CLANKY_API_KEY=<worker-api-key> \
clanky mesh status
```

The local `node` should show the configured name, endpoint, and execution
policy. Inspect `clanky mesh status` on the controller as well; the worker
should appear as an active member and, when remote execution is enabled, as an
available execution server.

`clanky serve status` reports whether the local detached process is running.
The browser application and unrelated API paths returning `404` is expected in
Mesh-worker mode.

## Common errors

| Error or symptom | Meaning |
| --- | --- |
| `401 Unauthorized` from worker control commands | `CLANKY_BASE_URL` does not identify the worker or `CLANKY_API_KEY` is missing or invalid. |
| `mesh_instance_name_required` | Set `mesh/instance-name` before enrollment. |
| `mesh_public_base_url_not_configured` | Configure the endpoint advertised by the worker before enrollment. |
| `mesh_enrollment_token_invalid` | The token is invalid, expired, revoked, or already consumed. Create a new token on the controller. |
| `mesh_enrollment_controller_mismatch` | The supplied fingerprint does not match the controller that issued the token. |
| `mesh_control_request_unreachable` | The worker could not reach the controller endpoint supplied to `mesh enroll`. |
| Worker is linked but unavailable for execution | Set `acceptRemoteExecution` to `true` and confirm the member is active in `clanky mesh status`. |
