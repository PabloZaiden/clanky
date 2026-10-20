# Mesh workers and relays

Mesh lets a Clanky controller run workspaces on another host. A worker can
connect directly to one or more controllers, or it can make an outbound
connection through a relay when inbound connections are not possible.

Mesh access is host-level access. The worker directory is the default working
directory, not a sandbox or filesystem allowlist. Pair only controllers that
are trusted to execute commands and access files on the worker host.

Settings separates **Workers**, **Controller**, and **Relays**. Workers contains
the enrollment list and health action; **Enroll worker** opens a focused form
and then the join command. Open a worker for runtime/protocol details.
Controller contains the guarded name/endpoint form and local runtime metadata.
Controllers without an advertised endpoint can save their name without adding
one; replacing an existing endpoint still requires a valid URL.
Relays contains paired connections and primary selection; **Pair relay** or
**Edit pairing** opens the URL/name form and bootstrap configuration.

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

### Optional aggregated directory trees

Workers can advertise `directoryTree: 1` alongside the unchanged
`fileOperations: 2` capability. Controllers use it for full Code Explorer trees:
the worker traverses its native filesystem in one encrypted execution RPC rather
than requiring a Mesh request for every directory. This additive extension uses
the existing Mesh generation and does not require Bash or `commandExecution`.

`walkDirectoryTree` accepts a root `path`, `includeHidden` (default `false`), and
`deferredDirectoryNames` (an array of directory basenames, including an empty
array when nothing should be deferred). Its result is an array of
`{ path, kind, isSymbolicLink }`, with paths relative to the root using the
worker's POSIX or Windows path semantics, and `kind` equal to `file` or `directory`.
The root itself is omitted. Empty directories are included; deferred directories
are included without their contents. Descendant symlinks are classified by their
targets where possible but never traversed. An explicitly selected root may be a
directory symlink, just as with ordinary directory navigation.

Workers without this capability receive no new operation: the controller keeps
the existing per-directory traversal. An explicit
`mesh_execution_capability_unavailable` or `mesh_execution_operation_unsupported`
rejection also uses that traversal. Aggregates are bounded by the existing
8 MiB plaintext result limit; `mesh_execution_result_too_large` selects the same
fallback rather than returning a partial tree. Rejection-based fallbacks are
logged. Filesystem, authorization, transport, cancellation, and malformed-result
failures remain errors, not empty trees or compatibility fallbacks.

### Relayed file downloads and response flow control

Relayed HTTP responses use a negotiated, consumption-driven send window. The
sender keeps at most 16 binary frames of up to 64 KiB in flight and waits for
acknowledgements when the receiver consumes them. Slow downloads therefore
backpressure the worker instead of overflowing the relay receive queue. Files
remain streamed; the existing queue limits are not file-size limits.

This is an optional extension within Mesh v6. The initiator advertises
`x-clanky-mesh-response-flow: 1`; the peer confirms `responseFlowControl: 1`
in the HTTP response metadata before either side uses `http.response.ack`
frames. Acknowledgements are cumulative byte offsets at frame boundaries.
At EOF the sender drains acknowledgements through the final body byte, sends
the end frame, and waits for the receiver's normal close before releasing the
stream. Flushing a local socket alone does not confirm delivery through the
relay; this completion handshake also protects the final partial frame.
Both peers must support the extension to protect slow downloads. During a
gradual rollout, older peers retain the previous response behavior and never
receive acknowledgement frames. Upgrade the controller and affected worker;
the relay forwards these frames opaquely and does not need this extension.
The extension does not change request uploads or raw socket streams.

Consumer backpressure has no elapsed-time deadline: a slow or paused reader
withholds credit, and the sender waits without growing its bounded window.
The same applies while waiting for the socket send buffer to drain or the
receiver to confirm completion. Admitted file-download, streamed-video and
filesystem-content responses opt out of the generic HTTP idle timeout, including
direct Mesh file responses. No minimum download speed is required.

Transport liveness is separate from body progress: relay WebSockets retain
their ping/pong liveness checks, and connection setup and control requests
retain their bounded timeouts. Cancellation, disconnection, authorization
revocation or shutdown closes the owned stream and releases the pending wait.
A failed transfer remains an error, not a successful partial file.

Long downloads also renew their short-lived execution lease. Supporting workers
advertise `executionSessionRenewal: 1` inside the encrypted session-admission
payload. Only after that negotiation, the controller posts
`{ action: "renew", protocolVersion, sessionId, sessionToken, requestId }` to the
existing `/api/mesh/internal/execution/session` route, with matching session
and request identity headers. The worker revalidates the token, active controller
grant, file-operation capability, execution channel and protocol before renewing
the existing lease. The ordinary 45-second admission and 60-second maximum lease
remain unchanged; active transfers renew before expiry instead of increasing
these limits.

The controller shares renewal across its active file streams and stops it when
the last stream completes, fails or is cancelled, or the session closes. A
terminal renewal failure aborts the affected streams explicitly. Older workers
do not advertise support and receive no renewal operation; both controller and
worker need this extension for transfers lasting beyond the original lease.
It uses an existing HTTP route, so the relay does not need an update.

## Choose a harness

The workspace selects the adapter; each task or chat selects its model.
Execution-host transport and harness are independent:

| Execution host | Available adapters |
| --- | --- |
| Local | Copilot native, Codex native, OpenCode 2 native, ACP |
| Mesh v6, including v6 relays | Copilot native, Codex native, OpenCode 2 native, ACP |
| Direct SSH | ACP only |

Install and authenticate the selected runtime under the **worker service
account**, not just on the controller. Native support uses the current
Copilot SDK and native CLI packages for Copilot, Codex app-server, and OpenCode
runtime/client. ACP remains an independent provider with its own selected
harness preset, never an automatic native fallback. Existing workspace presets
migrate to the ACP adapter without changing their original preset.

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

Native event-response backpressure is not an observation gap. A full response
queue pauses consumption; the 15-second heartbeat skips a keepalive when no
response capacity is available instead of closing the native lease. Provider
events retain their order and the separate 256-event subscriber queue remains
bounded and fails explicitly on real overflow. Heartbeats do not accumulate
while a consumer is paused.

Worker observation failures use the existing encrypted error-event contract.
The controller retains `harness_event_gap` for observation integrity failures
and `harness_transport_closed` for disconnection rather than replacing them
with a generic relay error. Unknown exception details remain private. Upgrade
the affected worker for the heartbeat correction and both worker and controller
for typed observation failure handling; no relay upgrade or wire-generation
change is required.

Preserve the worker data directory during upgrades and service restarts. Do
not copy a conversation binding to another user, workspace, controller, or
worker. The workspace directory remains a navigation root, not a sandbox.

## Independent worker lifecycle

Creating, enrolling, restarting, rebuilding, revoking, or deleting a worker
does not disconnect tasks or chats on another worker. This also applies to
automatic workspace provisioning and maintenance. Multiple workspaces on the
same worker share that worker's availability; restarting it can interrupt all
of them.

Inventory and health refreshes do not cancel healthy conversations. Runtime
metadata refreshes retire only the affected worker's cached execution
connections. Re-enrollment with the same route and configuration, an unchanged
endpoint, and instance-name changes do not interrupt active sessions.

Revocation, a changed worker route or endpoint, disabling remote execution, or
removing execution capabilities invalidates resources belonging to that user
and worker. Intentional connection closures report `harness_transport_closed`
with their lifecycle reason. New execution cannot reuse a revoked grant.
Relay maintenance affects the routes using that relay, not direct workers or
workers using another relay. Switching the primary relay does not migrate
existing routes.

After a real interruption, native inputs are not automatically resent. Preserve
the worker data directory and original conversation binding for recovery;
creating a replacement worker does not transfer ownership of old sessions.

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

On macOS, `restart` uses `launchctl kickstart` so a restart dispatched through
Mesh can replace the worker without unloading the LaunchAgent that owns the
running command. Use `clanky worker service install` when the LaunchAgent plist
itself must be regenerated.

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

**Settings > Workers** lists enrollments, checks health, opens worker runtime
details, and offers **Stop** or **Revoke** for global workers. Revoked global
registrations can be deleted. Dedicated workers remain managed by their
workspace lifecycle. A service supervisor can start a stopped process again.
Execution acceptance remains worker-owned configuration; disabling it keeps
the enrollment but prevents selection for new remote work.

To update a service-managed worker, replace the standalone binary and run:

```bash
clanky update
clanky worker service install
```

The service installation keeps the existing worker data and Mesh identity.

### Update servers and automatic workspaces together

From the controller, use **Settings > Maintenance > Clanky on servers and
automatic workspaces > Update all** to start one background job per active
Mesh worker, including workspace-exclusive automatic workers. The same owner-only action
is available through `POST /api/worker-update-jobs`; read progress and logs
with `GET /api/worker-update-jobs` and `GET /api/worker-update-jobs/:id`.

Jobs run concurrently across workers. Each checks that its service or workspace
loop is running, then runs `clanky update` and
restarts the worker service with `clanky worker service restart` only after the
update succeeds. Automatic workers configured for prereleases add `--pre-release`.
If the update fails, the restart is skipped. Updating a workspace worker uses
Mesh directly: it does not need SSH credentials, contact the provisioning host,
rerun provisioning, or restart the container. Restart response
and recovery checks share a 20-second deadline. Restart runs as a host-owned
asynchronous command: stopping response observation neither cancels nor resends
it. A still-running command remains under observation until it finishes, loses
its connection, or reaches the deadline. Recovery polls every second for a fresh signed Mesh
health check and a new execution connection to confirm that the service or
workspace loop is running. Workers reporting runtime metadata must return a
different instance ID and run the version reported by the installed binary
after updating. Losing the restart command's response does not by
itself interrupt the job if the command was dispatched; failures before dispatch
cannot count as a successful restart. The restart command is not resent. Explicit
command failures remain failures; recovery that cannot be confirmed within the
deadline is marked **Outcome unconfirmed** rather than successful or interrupted.
Failure to connect before dispatch is **Could not connect**; a returned command
failure is **Failed**. **Interrupted** requires observed execution and confirmed
termination. A controller restart does not prove remote execution stopped:
undispatched jobs become **Not started**, and possible execution with no known
result becomes **Outcome unconfirmed**. No command is automatically replayed.
If update already succeeded but restart was never dispatched, the pipeline is
**Failed** with the completed update preserved, not **Not started**.
Jobs and their logs remain on the Dashboard until dismissed.

Automatic workspaces created with the older one-shot launcher need a manual
launcher upgrade before this update flow can restart them safely. There is no
startup migration of existing Devboxes. Unmanaged or unreachable workers report
an individual job failure rather than preventing other workers from updating.
SSH-only automatic workspaces without a Mesh worker are not update targets.
Use the workspace's individual **Restart** or **Rebuild** action for container
maintenance, not for routine Clanky updates. The bulk restart API remains
available for explicit provisioning lifecycle operations.

Use **Dismiss all** in the Dashboard's **Worker updates** panel to remove
terminal jobs and their logs after confirmation.
Pending, connecting, running, and verifying jobs are kept. Individual jobs can still be dismissed from
their detail view.

## Automatic workspace runtimes

Automatic workspace creation selects **ACP**, **GitHub Copilot**, **Codex**, or
**OpenCode 2**. ACP also selects a harness preset. Native adapters require a
dedicated worker; direct SSH execution remains ACP-only. The host running
Devbox can use local, SSH or Mesh execution independently of the container's
adapter.

The persistent `.devbox/clanky-worker` startup assets store the selected
adapter/preset and install only its current native CLI before starting the
worker. Node/npm must be available in the container. ACP does not install an
additional CLI. Installation uses a private prefix, validates only that the
selected executable was installed, and adds a stable private bin directory to
the worker's PATH. OpenCode 2 is exposed as `opencode2`, without replacing a
system OpenCode generation-1 executable.
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

Maintenance jobs distinguish connection failure before dispatch, returned
command failure, confirmed interruption, and an unconfirmed remote outcome.
If a restart/rebuild response is lost, Clanky verifies read-only Devbox status
and the existing worker/backend connection instead of resending the command.
Successful verification confirms recovery; failed verification leaves the
outcome unconfirmed. A controller restart likewise does not prove that remote
execution stopped or authorize replay. Server `arise` jobs remain unconfirmed
when their result is lost because host reachability alone cannot prove that
the server update completed.

To manually select the Clanky binary channel for an automatic worker, edit
`.devbox/clanky-worker/launcher.sh` in the workspace repository on its
execution host. Set `CLANKY_RELEASE_CHANNEL='prerelease'` to install the latest
published prerelease when first installing or changing channels; set it to
`stable` to use the stable channel. Ordinary starts reuse the installed binary;
use **Update all** for subsequent updates. Prerelease downloads require and verify the release
asset's SHA-256 checksum, and do not fall back to stable if no prerelease is
available.

The **Restart** and **Rebuild** views expose the same choice under **Advanced
options** for worker-backed workspaces. Selecting it stores the prerelease
channel in the persistent launcher for future automatic starts. Leaving it
unchecked writes the stable channel.
Changing a worker workspace's runtime adapter preserves the channel already
stored in the launcher.

### Worker process loop

New automatic worker workspaces use a persistent shell loop in
`.devbox/clanky-worker/supervisor.sh`. The launcher installs Clanky when missing
or when its selected release channel changes, then starts the loop in the
background. The loop runs the binary, waits for it to exit, and executes the
same path again. Installation and runtime package setup are outside the loop;
restarting the worker after an update does not download or reinstall anything.

The loop requires `flock` from util-linux in the container. A kernel-held lock
prevents duplicate loops and is released when the process exits. Worker output
and restart diagnostics go to `.devbox/clanky-worker/worker.log`. The loop keeps
retrying until explicitly stopped. It waits one second between normal launches;
repeated launches lasting less than five seconds increase that delay
exponentially up to 30 seconds rather than spinning. A run lasting at least five
seconds resets the delay.

Inside the worker's execution environment, `clanky worker service status`,
`restart`, `stop`, and `start` control this loop instead of systemd. For direct
container administration, use:

```bash
sh <workspace-directory>/.devbox/clanky-worker/supervisor.sh status
sh <workspace-directory>/.devbox/clanky-worker/supervisor.sh restart
sh <workspace-directory>/.devbox/clanky-worker/supervisor.sh stop
sh <workspace-directory>/.devbox/clanky-worker/launcher.sh
```

`restart` terminates only the worker; the already-running loop starts its
replacement even if the Mesh connection disappears. `stop` records an intentional
stop, terminates the loop and worker, and waits for shutdown. Running the launcher
explicitly starts it again. Provisioning cleanup stops the loop, and removing
the dedicated worker's last controller grant records a permanent stop before the
worker awaits its command cleanup and normal server shutdown, so retiring a
workspace cannot resurrect its runtime or leave its commands running.
If the loop exits unexpectedly while its worker remains alive, startup refuses
to replace that worker. Run the supervisor's `stop` command before starting
the launcher again.

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
