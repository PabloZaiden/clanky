# Mesh workers and relays

Mesh lets a Clanky controller run workspaces on another host. A worker can
connect directly to one or more controllers, or it can make an outbound
connection through a relay when inbound connections are not possible.

Mesh access is host-level access. The worker directory is the default working
directory, not a sandbox or filesystem allowlist. Pair only controllers that
are trusted to execute commands and access files on the worker host.

## Protocol generations and migration

Mesh protocol generations are global and aligned with the Clanky release major.
Clanky 6.1 and later uses Mesh v6 exclusively. Every controller, relay, and
worker on a route must share a supported generation. Capability lists need not
be identical or ordered the same: each route selects the highest generation
shared by every hop and rejects the route when there is no intersection.
Additional peer capabilities are metadata only; a process does not parse or
emit contracts for generations it does not implement. Startup migration
normalizes persisted protocol metadata to v6 without replacing identities,
keys, or grants. Successful signed exchanges and relay reconnects refresh peer
evidence.

The Mesh status and Settings views show each controller, relay, and worker
binary version, supported generations, and the generation observed in the last
successful exchange, plus execution-host capabilities. Local protocol status
also advertises the binary's harness adapters; an adapter being present does
not prove its external runtime is installed or authenticated.

Before selecting a native adapter, check worker and relay generations in
`clanky mesh status` and `clanky mesh relay status`. A native request rejected
by a Mesh route is not retried through ACP. Explicitly select ACP on the
workspace when that is the desired integration.

## Choose a harness

The workspace selects the adapter; each task or chat selects its model.
Execution-host transport and harness are independent:

| Execution host | Available adapters |
| --- | --- |
| Local | Copilot native, Codex native, OpenCode 2 native, ACP |
| Mesh v6, including v6 relays | Copilot native, Codex native, OpenCode 2 native, ACP |
| Direct SSH | ACP only |

Install and authenticate the selected runtime under the **worker service
account**, not just on the controller. Native support uses Copilot SDK 1.0.15
with CLI 1.0.91, Codex app-server CLI 0.159.2, and OpenCode runtime/client
2.0.20. ACP remains an independent provider with its own selected harness
preset, never an automatic native fallback. Existing workspace presets migrate
to the ACP adapter without changing their original preset.

Native Mesh uses a provider-neutral encrypted RPC/lifetime-event gateway,
not ACP framing. The worker owns native subprocesses and performs repository
operations on that host through `CommandExecutor`. Model catalogs, native
conversation IDs, principal/child attribution, admission receipts, and scoped
Stop retain the selected provider's capabilities and limitations.

## Native lifetime, recovery, and cleanup

- Assistant message completion is not principal turn completion or quiescence.
  Lifetime activity continues after a prompt ends; stopping one owned child
  does not stop the principal, siblings, worker, or controller.
- Completed task results stay completed even if owned background work remains.
  Cleanup and Git safety are separate; failed activity queries are unavailable,
  never an empty successful graph.
- Native admission records keep the canonical queued-input ID separately from
  native client/message/turn IDs. An unknown admission is not unsent: reconcile
  it before deleting, replacing, draining, or retrying that input.
  A lost, malformed, or mismatched receipt remains unknown.
- Native leases use the existing signed controller grant, encrypted managed
  environment, execution-host ownership, renewal, and relay protections.
  Expiry, revocation, disconnect, and shutdown close the lease-owned runtime
  and its subscriptions/processes. Deleting one conversation does not release
  unrelated conversations on the same lease.
- Cold resume must retain the original adapter, native ID, user, workspace,
  context, directory, and execution-host binding. Worker-side ownership is
  durable across leases; a changed or foreign binding is rejected rather than
  silently replaced. Resolving a selected-host working directory does not
  rewrite the original directory in its ownership binding.
- Event observation is bounded and has no retained global history. A sequence
  gap or overflow invalidates observation and requires authoritative refresh
  and owned resume, not blind prompt or steering replay.

Preserve the worker data directory during upgrades and service restarts. Do
not copy a conversation binding to another user, workspace, controller, or
worker. The workspace directory remains a navigation root, not a sandbox.

## Choose a topology

| Situation | Setup |
| --- | --- |
| The controller can reach the worker over HTTPS | Direct worker |
| The worker cannot accept inbound connections | Relay plus relay-only worker |
| The repository is already reachable over SSH | Registered SSH host |

Use HTTPS for worker and relay endpoints. Plain HTTP is only appropriate for a
deliberately trusted private network during local development.

## Set up a relay

Run this on the controller to display the fingerprint assigned to the relay:

```bash
clanky mesh relay bootstrap-info
```

Start the dedicated relay image behind your reverse proxy:

```yaml
services:
  relay:
    image: ghcr.io/pablozaiden/clanky-relay:latest
    restart: unless-stopped
    expose:
      - "8080"
    environment:
      CLANKY_RELAY_CONTROLLER_FINGERPRINT: "<controller-fingerprint>"
    volumes:
      - relay-data:/app/data

volumes:
  relay-data:
```

Then pair the controller with the relay:

```bash
clanky mesh relay pair https://relay.example.com --name east
clanky mesh relay status
```

The relay URL must be the external HTTPS origin. Its reverse proxy must
forward HTTP and WebSocket traffic while keeping the relay listener private.
Persist `/app/data` so the relay signing identity and fingerprint survive
container recreation.

To add another relay, run a separate relay instance with its own data volume,
URL, and the same controller fingerprint, then pair it under a different name:

```bash
clanky mesh relay pair https://relay-west.example.com --name west
clanky mesh relay primary west
```

Names are unique, case-insensitive, and use letters, numbers, hyphens, or
underscores (up to 64 characters). Pairing the first relay makes it primary.
`primary` changes only which relay is selected for new invitations without a
relay name; it does not move existing workers or change their connections.
Controllers maintain independent connections and worker authorization for all
paired relays. An existing single-relay pairing is migrated under the name
`default`; `pair` and `unpair` always require an explicit name, including for
that migrated relay.

To remove a pairing:

```bash
clanky mesh relay unpair --name west
```

This disconnects the controller from that relay without deleting worker
enrollments or clearing trust on the relay. Workers using it cannot reach the
controller until the same URL and relay identity are paired again, or they
are reenrolled through another relay. Removing the primary does not promote
another relay: choose one with `clanky mesh relay primary <name>` before
creating relay invitations without an explicit relay name.

The relay persists its signing identity in `relay-identity.json` under
`CLANKY_DATA_DIR`. Controller pairing and the authorized-worker snapshot exist
only in relay memory. After a relay restart, it accepts the configured
controller fingerprint, then rebuilds pairing and worker authorization from
the controller's next connection and full snapshot. Workers remain
unauthorized until that snapshot arrives. Relay activity is sent through the
standard WebApp logger to stdout/stderr: routine connection and stream details
are visible at trace level, and abnormal outcomes remain warnings. The relay
does not retain a persistent audit history.

## Bootstrap a direct worker

Run this on the host that will execute workspaces:

```bash
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint https://worker.example.com
```

The endpoint must be reachable by the controller. If the worker has no DNS
name, use a stable reachable address and include the port:

```bash
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint https://203.0.113.10:3000
```

Workers use HTTPS and a durable self-signed identity by default. The
controller pins that identity when the worker is enrolled. Do not use
`localhost`, `127.0.0.1`, or an address the controller cannot route to.

For a trusted private network only, explicitly opt into HTTP:

```bash
clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint http://203.0.113.10:3000 \
  --insecure
```

The worker data directory defaults to `$HOME/.clanky`. Set
`CLANKY_DATA_DIR` when the worker should store its state elsewhere:

```bash
CLANKY_DATA_DIR=/srv/clanky-worker \
  clanky worker bootstrap \
  --host 0.0.0.0 \
  --port 3000 \
  --worker-directory /workspaces \
  --instance-name worker-1 \
  --mesh-endpoint https://worker.example.com
```

The bootstrap command prints the worker API key only when it creates or
rotates it. Keep that value on the worker; enrollment uses a short-lived
controller token instead.

## Bootstrap a relay-only worker

Use relay-only mode when the worker must not listen on a public worker
endpoint:

```bash
clanky worker bootstrap \
  --relay-only \
  --worker-directory /workspaces \
  --instance-name worker-1
```

Relay-only workers listen only on loopback, do not accept `--mesh-endpoint` or
`--insecure`, and maintain an outbound connection through the paired relay.

## Run the worker as a service

Bootstrap the worker first, then install its operating-system service as the
worker account:

```bash
clanky worker service install
clanky worker service status
```

Use the same `CLANKY_DATA_DIR` value used during bootstrap. Manage the service
with:

```bash
clanky worker service start
clanky worker service stop
clanky worker service restart
clanky worker service uninstall
```

Use `--no-start` when installation should register the service without starting
it immediately. The service account needs access to Git, the selected provider
runtime, the workspace directory, and any other tools used by tasks.

On Linux, installation creates systemd services. On macOS, it installs a
per-user LaunchAgent; the worker can request Accessibility, Screen Recording,
and Files and Folders permissions when those capabilities are used. On
Windows, install a trusted WinSW executable separately and set
`CLANKY_WORKER_SERVICE_WRAPPER` to its absolute path during service
installation.

## Enroll a worker

Create a single-use invitation on the controller. Use `--route direct` for a
direct worker:

```bash
clanky mesh enrollment-token create --name worker-1 --route direct
```

For a relay-only worker, use `--route relay`:

```bash
clanky mesh enrollment-token create --name worker-1 --route relay
```

Without `--relay`, the invitation uses the current primary relay. To choose
a different paired relay, specify its name:

```bash
clanky mesh enrollment-token create --name worker-2 --route relay --relay east
```

The selected relay is part of the token's trust boundary: the token cannot
enroll a worker through a different relay even if the worker changes the
generated command's URL. Settings offers the same choice when issuing worker
invitations, including dedicated workspace workers.

The JSON response contains `response.workerJoinCommand`. Run the complete
command on the worker, replacing the placeholders only if you are not using
the generated value:

```bash
clanky worker join 'https://controller.example.com' \
  --token '<single-use-token>' \
  --fingerprint '<controller-fingerprint>'
```

For a relay invitation, the generated target is the relay:

```bash
clanky worker join 'https://relay-west.example.com' \
  --token '<single-use-token>' \
  --fingerprint '<controller-fingerprint>'
```

Repeat enrollment for every controller that should use the worker. Verify the
connection on the controller:

```bash
clanky mesh status
```

Enrollment tokens are short-lived and single-use. The worker's local identity
and API key do not need to be copied to the controller.

For scripted enrollment without the generated command, use
`clanky mesh enroll <target> --token <token> --fingerprint <fingerprint>`.
`CLANKY_MESH_CONTROLLER_FINGERPRINT` can provide the fingerprint instead of
the flag.

## Operate workers

From the controller:

```bash
clanky mesh status
clanky mesh revoke <worker-node-id>
```

The **Settings > Mesh > Workers** view can also inspect workers, disable
**Accept remote execution**, or use **Kill** to terminate a worker process.
Disabling execution keeps the enrollment but prevents the worker from being
selected for new remote work. A service supervisor can start the process again
after it exits.

To update a service-managed worker, replace the standalone binary and run:

```bash
clanky update
clanky worker service install
```

The service installation keeps the existing worker data and Mesh identity.

## Automatic workspace runtimes

Automatic workspace creation selects **ACP**, **GitHub Copilot**, **Codex**, or
**OpenCode 2**. ACP also selects a harness preset. Native adapters require a
dedicated worker; direct SSH execution remains ACP-only. The host running
Devbox can use local, SSH or Mesh execution independently of the container's
adapter.

The persistent `.devbox/clanky-worker` startup assets store the selected
adapter/preset and install only its native CLI before starting the worker.
Node/npm must be available in the container. Packages are pinned to validated
versions: `@github/copilot@1.0.91`, `@openai/codex@0.159.2` and
`@opencode/cli@2.0.20`. ACP does not install an additional CLI. Installation
uses a private prefix, checks the CLI version and adds a stable private bin
directory to the worker's PATH. OpenCode 2 is exposed as `opencode2`, without
replacing a system OpenCode generation-1 executable.
When npm requires install-script approval, it is recorded only for the selected
package in this private prefix; global npm policy is not changed.

Changing an existing automatic workspace's adapter installs the selected
dependency before saving settings and updates its durable requirements.
Failed installation leaves the saved selection unchanged. Runtime saves and
Clanky-managed rebuild/restart jobs are serialized per workspace. Previously
installed private runtimes remain cached; global packages and authentication
profiles are untouched. Authentication still needs to be configured separately.

Rebuild/restart preserves the current workspace runtime. The Devbox
`startup-command` persists in its state and runs on external `devbox up`,
`devbox rebuild` and `devbox arise`, without a running Clanky controller.
Raw Docker restarts and other devcontainer tools do not invoke that Devbox
hook. Existing automatic workspaces acquire these assets on their next
Clanky-managed rebuild/restart or adapter change; existing ACP selections are
not automatically converted to native adapters.

To manually select the Clanky binary channel for an automatic worker, edit
`.devbox/clanky-worker/launcher.sh` in the workspace repository on its
execution host. Set `CLANKY_RELEASE_CHANNEL='prerelease'` to install the latest
published prerelease on each automatic start; set it to `stable` to use the
latest stable release. Prerelease downloads require and verify the release
asset's SHA-256 checksum, and do not fall back to stable if no prerelease is
available.

The **Restart** and **Rebuild** views expose the same choice under **Advanced
options** for worker-backed workspaces. Selecting it stores the prerelease
channel in the persistent launcher for future automatic starts. Leaving it
unchecked writes the stable channel.

## GitHub CLI credentials in automatic workspaces

When Devbox provisions an automatic workspace, Clanky can pass the selected
GitHub CLI account's `GH_TOKEN` to interactive terminals on that execution
host. This lets `gh` and Copilot CLI reuse the workspace authentication
without a second login.

The token is not stored in Clanky or sent through the Mesh protocol. Run only
trusted code in workspaces where this behavior is enabled, because terminal
processes can read inherited environment values.

## Troubleshooting checklist

- Confirm that the controller can reach the worker or relay endpoint.
- Use the exact HTTPS origin configured during bootstrap and pairing.
- Check that the reverse proxy forwards WebSocket upgrades.
- Verify the worker service runs as the account that owns its data directory
  and can find Git and the provider runtime.
- Revoke and enroll again after intentionally rotating a worker identity.
