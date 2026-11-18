# Mesh workers and relays

Mesh lets a Clanky controller run workspaces on another host. New workers
connect outward to the HTTPS controller or relay named in their invitation.
Neither topology requires an externally reachable worker listener.
Existing listener-based direct workers retain their enrolled routes.

To let another full Clanky instance use selected existing workspaces without
exposing its execution host, use [workspace collaboration](workspace-collaboration.md)
instead of worker enrollment. Invited Clanky instances and browser-only clients
can connect directly to the controller's advertised HTTPS endpoint or through
a paired relay. These are separate collaboration transports and do not change
existing worker relationships.

Mesh access is host-level access. The worker directory is the default working
directory, not a sandbox or filesystem allowlist. Pair only controllers that
are trusted to execute commands and access files on the worker host.

Settings separates **Workers**, **Controller**, and **Relays**. Workers contains
the enrollment list and health action; **Enroll worker** opens a focused form
and then the join command. Open a worker for runtime/protocol details.
Controller contains the guarded name/endpoint form and local runtime metadata.
Controllers without an advertised endpoint can save their name without adding
one; replacing an existing endpoint requires a valid HTTPS URL.
Relays contains paired connections and primary selection; **Pair relay** or
**Edit pairing** opens the URL/name form and bootstrap configuration.

## Protocol and transport security

Mesh protocol generations are global and aligned with the Clanky release major.
Only Mesh v7 is supported. Every controller, relay, and worker on a route
must support v7, with HTTPS/WSS on every hop. Discovery and negotiation reject
incompatible peers before parsing session contracts. Additional advertised
generations are metadata only and do not enable another wire format.

Selection is automatic, with no activation flag:

| Route | New session |
| --- | --- |
| Mesh 7 controller and worker, direct HTTPS | v7, trusted TLS |
| Mesh 7 controller, selected relay and worker, HTTPS/WSS on both hops | v7, trusted TLS |
| Incompatible peer or relay, or an insecure transport | Rejected |

Native RPC/event frames and execution, terminal and tunnel admission responses
use `payload`; managed environments use `environment`. The protocol version
is checked against the admitted session before reading or responding.
Admissions and session traffic require TLS, including on loopback; Mesh peer
requests do not follow redirects.

**Relays and TLS-terminating proxies are trusted with Mesh 7 content.** This
is hop-by-hop TLS, not an opaque end-to-end tunnel: a relay can see traffic
after TLS termination. The relay still only authenticates nodes, routes
bounded streams and forwards bytes with backpressure; it does not decode
agent/tool payloads or perform application payload encryption. Node signatures,
certificate verification, grants, ownership, tokens, expiry, renewal and
revocation remain in place. The signed v7 identity and enrollment contracts
retain their required key fields; these are not payload-encryption support.

Preserve data directories during upgrades so identities, keys, grants and
enrollment remain intact. New admissions discover the worker's signed
capabilities; relay reconnects rediscover support before opening a control
link. An admission failure or ambiguous dispatched command/prompt is never
replayed using another protocol. A reconnect does not resend user input.

Initial relay connections and reconnects require successful discovery before
opening the control socket. Failed discovery or a mismatched identity never
falls back to stored protocol capabilities: the existing connection manager
retries with bounded backoff until discovery succeeds. The link stays
unavailable during that retry, without changing its pairing or grants.
Healthy connected links are not polled or interrupted to renegotiate.

Temporary connection loss never exhausts the relay retry loop while the
relationship remains configured and authorized. This includes heartbeat,
discovery and socket-close failures: retries continue with bounded backoff
without restarting the service or replaying commands. If graceful closure
stalls, Bun runtimes forcibly terminate the old control socket before
reconnecting. A transport that cannot yet finish closing remains owned and its
cleanup is retried rather than disabling reconnection or accumulating replacement
sockets. Explicit shutdown or removal of the relationship stops maintenance.

The Mesh status and Settings views show each controller, relay, and worker
binary version, supported generations, and the generation observed in the last
successful exchange, plus execution-host capabilities. Local protocol status
also advertises the binary's harness adapters; an adapter being present does
not prove its external runtime is installed or authenticated.

`clanky mesh status` also reports each controller-side worker's
`routeSecurity`: the selected generation for new admissions,
`payloadProtection` (`trusted-tls` or `unavailable`), and
`fallbackReason` when TLS or peer/relay support is missing. This is route
eligibility based on the last verified capabilities, not a live health probe.
Worker status exposes v7 `activeSessions` counts for execution/native,
terminal and TCP leases.

Before selecting a native adapter, check worker and relay generations in
`clanky mesh status` and `clanky mesh relay status`. A native request rejected
by a Mesh route is not retried through another adapter.

### Managed controller certificates

A private controller can enable
[managed HTTPS](deployment.md#optional-controller-managed-https) at its stable
LAN/Tailscale IP or network hostname. The existing **Enroll worker** flow
automatically includes `--controller-cert` in direct invitations when that
listener uses a managed certificate. Copy the entire generated command and use
an updated CLI. The flag contains the base64 public PEM, not a private key.
The existing signing-key fingerprint and single-use token remain separate.

The worker validates the certificate, hostname, dates and fingerprint before
using it for discovery and enrollment. Its controller grant persists scoped
trust for subsequent HTTPS requests, control/data WebSockets and reconnects.
No insecure verification, redirect fallback or global worker CA installation
is needed. Workers still connect outward and need no public listener.
Ordinary public-PKI/proxy routes and relay invitations keep their existing
system trust, without the certificate flag. Mesh stays v7; trust is local
grant state, not an enrollment wire-format change.

Restarting a controller preserves its TLS identity. Explicit TLS rotation or
loss of that identity requires re-enrollment with a fresh command; workers do
not silently accept a replacement certificate. Re-pairing updates the live
connection's trust. Dispatched commands or prompts are never replayed.

### Protocol evolution

For a future breaking wire change, keep generations global and aligned with
the Clanky release major. Introduce the new generation behind a narrow
compatibility adapter, migrate existing persisted Mesh state idempotently at
startup, and negotiate the highest mutually supported generation before
parsing or emitting contracts.

Keep the old generation isolated during a short dual-version rollout and
expose binary/protocol metadata in status so completion is observable. Remove
the old adapter, migration-only paths, and compatibility tests only after every
controller, relay, and worker has been confirmed on the new generation. Do not
mix compatibility cleanup with the wire-contract change. This policy governs
future transitions; it does not restore support for pre-v7 peers today.

### Execution-owned control tools

Native control tools use a scoped connection owned by their admitted execution,
not a CLI API key or `CLANKY_BASE_URL`. The controller owns source/account/grant
validation. Mesh carries correlated control request/cancel frames through the
existing harness event stream and replies through harness RPC. The lease-level
control observation is ready before provider connection or conversation
creation/resume, including OpenCode's early discovery. Reply capacity is
independent of operations waiting for those replies.
Track active calls separately from replies awaiting acknowledgement. Wait for
bounded reply capacity rather than closing a healthy lease when those stages
overlap.

Current controllers request `x-clanky-mesh-control-tools: 2` during generation
discovery and require signed `controlTools: 2` metadata before admission. The
signed lease enables that capability without sending a bearer credential.
Both controller and worker must support v2; current controllers never fall back
to v1 callbacks or a tool-less session. The global Mesh generation remains v7.
Discovery without the opt-in and noncontrol contracts are unchanged.

Direct TLS and relay use the same execution infrastructure. No independent
worker-to-controller callback, public hostname, route backfill or pairing reset
is needed. Existing v7 relays already forward these harness routes. Worker
binding, including its revision, and active registration are revalidated on
each request. Observation loss closes the lease; calls/results are bounded
and cancellable, and a missing
authoritative result is uncertain, never automatically replayed.

During rollout, workers retain the old v1 discovery/admission and callback in
one isolated adapter for older controllers. The existing narrow relay callback
allowlist remains so a relay upgrade does not break an older pair. It is not
selected by current controllers; remove this compatibility only after fleet
rollout is confirmed, following [protocol evolution](#protocol-evolution).
Relays still reject Authorization headers and arbitrary API forwarding.

Deterministic tools and current-conversation prompts use their trusted runner
and selected executor's existing communication, without public HTTP or injected
CLI credentials. Explicit human CLI/terminal behavior is unchanged.

HTML artifact publication requires the execution host's additive
`htmlArtifacts: 1` capability. Controllers withhold the tool from older workers.
HTML files and local source images are resolved on the admitted execution host.
The controller persists the prepared artifact without running a browser; the
user's browser renders it. Existing v7 relays forward the bounded results
through the same control channel. See [inline visuals](control-chats.md#inline-visuals)
for optional visual inspection using the agent's existing tools.

### Private CLI secret files

Native harness capability discovery optionally advertises `secretFiles: 1`.
Supporting controllers opt interactive conversations into that capability in
their binding; workers do not register the tool for older controllers that
omit the opt-in. Unsupported workers continue ordinary chat without it.
This is additive within Mesh v7, independent of the Control-tools capability
and grant.

Only secret-request metadata uses the normal harness question event stream.
The private human response uses the authenticated, conversation-correlated
`secret.reply` harness RPC, never a normal question answer or a Control frame.
The worker's native callback waits locally, so the human wait does not occupy
a browser submission or Mesh RPC request. Relays need no new route or broader
forwarding.
Files and their 24-hour cache belong to the actual worker process, not to the
controller or native lease; reconnecting a lease does not delete them.
Worker restart invalidates the cache and removes the previous process's files.
See [private secrets](harnesses.md#private-secrets-for-cli-commands) for scope,
browser authentication, permissions, retention and security limits.

### Optional aggregated directory trees

Workers can advertise `directoryTree: 1` alongside the unchanged
`fileOperations: 2` capability. Controllers use it for full Code Explorer trees:
the worker traverses its native filesystem in one execution RPC rather
than requiring a Mesh request for every directory. This additive extension uses
the existing Mesh generation and does not require Bash or `commandExecution`.

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
backpressure the worker and keep the response's in-flight window bounded. Files
remain streamed; frame/window bounds are not file-size limits.

Relay receive, send, control and local-broker delivery queues have no fixed
accumulated frame-count or byte ceiling. Relay WebSocket send buffers explicitly
disable Bun's default backpressure ceiling instead of reintroducing a hidden
runtime cap. A slow consumer still controls the negotiated send window.
Unconsumed traffic may grow memory usage without a configured bound; concurrent
streams or a persistently faster producer can exhaust process memory.
The 2 MiB maximum transport-frame size and 64 KiB HTTP fragments remain:
large HTTP/native results span fragments, not a single transport frame.
Update controller, worker and relay binaries to apply this policy throughout
a deployment; no wire-generation change is required.

Response flow control is an optional Mesh v7 extension. The initiator advertises
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

Active synchronous commands, Git/file RPC operations and downloads renew their
short-lived execution lease. A command admitted near the lease deadline must
not be terminated by that deadline while its own execution timeout remains.
Supporting workers advertise `executionSessionRenewal: 1` inside the session-admission
payload. Only after that negotiation, the controller posts
`{ action: "renew", protocolVersion, sessionId, sessionToken, requestId }` to the
existing `/api/mesh/internal/execution/session` route, with matching session
and request identity headers. The worker revalidates the token, active controller
grant, execution capability, execution channel and protocol before renewing
the existing lease. The ordinary 45-second admission and 60-second maximum lease
remain unchanged; active operations renew before expiry instead of increasing
these limits.

The controller shares one renewal owner across its active RPCs and file streams
and stops it when the last operation completes, fails or is cancelled, or the
session closes. A terminal renewal failure aborts affected operations explicitly
without replaying dispatched commands. Idle sessions are not kept alive.
Older workers do not advertise support and receive no renewal operation; both controller and
worker need this extension for operations lasting beyond the original lease.
It uses an existing HTTP route, so the relay does not need an update.

## Choose a harness

The workspace selects the adapter; each chat selects its model.
Execution-host transport and harness are independent:

| Execution host | Available adapters |
| --- | --- |
| Local | Copilot native, Codex native, OpenCode 2 native, Claude Agent |
| Mesh v7, including relays | Copilot native, Codex native, OpenCode 2 native, Claude Agent |

Install and authenticate the selected runtime under the **worker service
account**, not just on the controller. Native support uses the current
Copilot SDK and native CLI packages for Copilot, Codex app-server, OpenCode
runtime/client and Claude Agent SDK/Claude Code. See
[workspace configuration](harnesses.md#workspace-configuration).

Native Mesh uses a provider-neutral versioned RPC/lifetime-event gateway.
The worker owns native subprocesses and performs repository
operations on that host through `CommandExecutor`. Model catalogs, native
conversation IDs, principal/child attribution, admission receipts, and scoped
Stop retain the selected provider's capabilities and limitations.

Saved subagent transcripts use the optional native `subagentHistory` capability
and an additive child-history read operation within Mesh v7. A controller never
sends that operation to an older worker that does not advertise it. Stored
controller-side child conversations remain readable without a worker
connection; missing recovery support is explicit and does not switch adapters.
The owned root lease, native lineage and cursors apply to child reads too.
History is paginated; a large event is allowed to exceed the normal page
batching target without invalidating the read.

## Native lifetime, recovery, and cleanup

- Assistant message completion is not principal turn completion or quiescence.
  Lifetime activity continues after a prompt ends; stopping one owned child
  does not stop the principal, siblings, worker, or controller.
- Native turn completion does not prove that owned background work has stopped.
  Cleanup and Git safety are separate; failed activity queries are unavailable,
  never an empty successful graph.
- Native admission records keep the canonical queued-input ID separately from
  native client/message/turn IDs. An unknown admission is not unsent: reconcile
  it before deleting, replacing, draining, or retrying that input.
  A lost, malformed, or mismatched receipt remains unknown.
- Native leases use the existing signed controller grant, protected managed
  environment, execution-host ownership, renewal, and relay protections.
  Without negotiated remote continuity, lease expiry and transport loss close
  the lease-owned runtime. Authorization revocation and worker shutdown still
  close retained runtimes. Deleting one conversation does not release unrelated
  conversations on the same lease.
- Cold resume must retain the original adapter, native ID, user, workspace,
  context, directory, and execution-host binding. Worker-side ownership is
  durable across leases; a changed or foreign binding is rejected rather than
  silently replaced. Resolving a selected-host working directory does not
  rewrite the original directory in its ownership binding.
- Observation frames are sequenced per connection, not a global event history.
  Native source or framing gaps still require authoritative refresh and owned
  resume, never blind prompt or steering replay.

### Controller reconnection

Updated controllers and remote workers explicitly negotiate execution
continuity within Mesh v7. It uses existing harness routes and needs no relay
protocol update. Older peers keep their existing disconnect behavior; execution
local to the controller is unchanged.

The worker retains active native execution, owned background work, pending
questions, permissions and private-input callbacks while the controller is
unreachable. There is no disconnect grace deadline. The controller automatically
reattaches using the original authenticated conversation binding, restores
actual activity and pending interactions, and observes output produced while
offline without resending the prompt.

Reconnection and history catch-up belong to each conversation, not server
readiness. An unavailable or recovering worker must not block the API or work
on other workers. Controller shutdown cancels its pending reattachments without
waiting for a remote response or terminating retained native execution.
Interrupted history catch-up resumes on the next attachment even when native
execution is already live.

Closing or releasing a controller attachment only detaches its transport lease;
it does not terminate retained execution, regardless of observation-stream
cancellation order. Explicit execution release and authorization revocation
remain terminal, as does worker shutdown.

Unacknowledged events stay ordered and in memory during healthy operation.
Disconnection spills outstanding and subsequent events to a private temporary
disk queue. That queue remains during catch-up; acknowledged prefixes are
reclaimed and the spool is removed when caught up. Both transcript consumers
acknowledge only after their projections are saved, and text offsets reconcile
replayed partial output without appending it twice. Replay stays bounded by
confirmed consumer progress, rather than loading an outage's entire disk queue
into controller memory. Recovered chats wait for
this durable catch-up before accepting another prompt or finalizing an
automation run. Provision enough worker
temporary storage for output produced during an extended outage. Storage
failures are explicit observation failures, not dropped events.

Controller-dependent calls can wait for reconnection, but the worker does not
become an authorization authority. Operations already marked as dispatched
return an uncertain-outcome failure rather than executing again. Native
interaction receipts reconcile answers whose response was lost. Explicit stops
and authorization revocation are not reconnection requests. An unconfirmed
remote stop remains pending and is retried when the worker is reachable, even
after a controller restart. Moving a retained remote chat to Trash requires
that stop to be confirmed first; if its worker is unavailable, retry deletion
after the pending stop finishes.

Already-admitted remote non-deterministic automation runs also reconnect to
their original run and conversation. Recovery does not repeat the prompt,
prepare another worktree, or start a replacement run. Code/deterministic
automations retain their existing restart/interruption policy; their execution
is not reconstructed or replayed.

This is not live recovery across a worker restart. Worker shutdown still stops
its runtimes, and a restarted worker uses the existing cold conversation
recovery. Lost in-flight execution and native callbacks are not reconstructed;
stale callback questions and permissions are expired during cold recovery.
An automation whose live execution was lost fails explicitly instead of
treating an idle cold-resumed conversation as proof of successful completion.
Its prompt is not repeated; ordinary chat history recovery remains available.

Native event-response backpressure is not an observation gap. A full response
queue pauses consumption; the 15-second heartbeat skips a keepalive when no
response capacity is available instead of closing the native lease. Provider
events retain their order; native event hubs and Mesh conversation/control
subscriptions do not discard output at an arbitrary queue-size threshold. Native events and
complete NDJSON observation records are not rejected for exceeding the former
2/4 MiB ceilings.
Validated provider images are forwarded in full instead of omitted solely
for their size. Heartbeats do not accumulate while a consumer is paused.

Worker observation failures use the versioned error-event contract.
The controller retains `harness_event_gap` for observation integrity failures
and `harness_transport_closed` for disconnection rather than replacing them
with a generic relay error. Known failures have specific safe messages and
allowlisted `details.reason` metadata: native source/translation failures,
missing tool starts, invalid frames/schema, sequence gaps, control/interaction
capacity and transport closure. Older peers and explicitly bounded consumers
can still report queue/size failures, including observed counts/bytes and limits.
Unknown exceptions retain a generic recovery message; neither their arbitrary
messages nor event/tool contents are forwarded as diagnostics.

Failure logs are emitted at warn/error levels. Worker records include adapter,
lease/conversation/context IDs, processing stage and last event type; event HTTP
and controller records include request ID, channel and last sequence. Safe cause
types are bounded to four entries. Relay failures distinguish rejected protocol
frames and socket send failures without logging payloads. Relay close audits
include the relay request/stream IDs and close code; send failures also include the native
request ID when it is a UUID, bridging native and relay correlation. Search
these IDs across controller, worker and relay logs rather than treating a later
disconnect as proof of the initiating failure.

Upgrade both worker and controller for the complete diagnostic propagation,
and the relay for its new failure metrics. This uses existing optional error
details and requires no wire-generation change. Diagnostics alone do not enable
the negotiated continuity described above, and never authorize input replay.

Preserve the worker data directory during upgrades and service restarts. Do
not copy a conversation binding to another user, workspace, controller, or
worker. The workspace directory remains a navigation root, not a sandbox.

## Selected SSH-agent keys

Load keys into the SSH agent on the intended local or enrolled Mesh custodian
using that host's normal agent tooling. In SSH-key source settings, explicitly
authorize that host, discover its loaded public identities and register the
desired aliases. Grant individual keys in a workspace's **Shared SSH keys**
panel or a registered server's **Shared SSH keys** panel; access starts empty.
Clanky stores public metadata and grants, never private keys or passphrases.
The custodian must remain connected and its selected keys must remain loaded.

Ordinary workspaces and direct server commands, terminals and chats can use
shared keys alongside the execution host's existing local agent identities,
SSH configuration and key files. Server grants apply only to direct server
execution; each workspace has separate grants. Clanky does not load or remove
keys from the original agent. Duplicate identities use their independently
available local signing route, so revoking a shared grant cannot revoke that
local access.

After enabling shared access for the first time, start a new terminal or
reconnect the chat so it receives the scoped socket. New commands pick it up
automatically. Later grant changes apply through that socket without restarting
the runtime. A persistent terminal keeps the context with which it was created;
reattaching does not change it. Shared identities remain listed if a custodian
disconnects, but signing with them fails explicitly; local identities remain
usable. Context deletion, changed execution bindings and revoked registrations
prevent further shared signatures.

Dedicated managed workers expose a private filtered `SSH_AUTH_SOCK` to their
Git, terminal and agent processes. Enabling or disabling a grant takes effect
without rebuilding. Identity listing and every signature recheck the account,
dedicated-worker binding and current grants. Revocation prevents new signatures;
it cannot terminate an already authenticated SSH session. Missing keys,
revoked access or disconnected custodians fail closed, not through an
unfiltered agent or private-key-file fallback.

Initial private cloning uses an expiring lease bound to the allocated
environment, provisioning operation and verified provisioning host. Its socket
must be closed when that operation finishes or is cancelled. Git consumers use
the scoped socket with key-file fallback disabled and strict SSH server
host-key verification. Provisioning hosts need the correct server entry in
their normal known-hosts store; Clanky does not accept unknown host keys.

This is an explicitly negotiated, signed `sshAgent: 1` extension within Mesh
v7, with additional `contexts: 1` negotiation for general consumers. Update
controller, custodian, workspace worker and any relay before using
it. Relays admit only the bounded SSH-agent route, not arbitrary API forwarding.
Signing uses node trust and active grants, not an API token or control-tool
conversation. Manual dedicated-worker integrations enable the socket with
`CLANKY_WORKSPACE_SSH_AGENT=1`. If the application data directory is too long
for a Unix socket pathname, set `CLANKY_SSH_AGENT_SOCKET_DIR` to an absolute,
private directory owned by the worker user.

Clanky-managed SSH agents and the local service relay remain unchanged. After
updating a Linux worker, run `clanky worker service install` as its service
account, using the existing `CLANKY_DATA_DIR`, to refresh the generated shell
integration before using interactive shared-key terminals. This reinstalls and
restarts the service; replacing the binary or restarting it alone does not
regenerate the helper. The helper must preserve a Clanky-scoped runtime socket
instead of replacing it with the server's base socket.

## Independent worker lifecycle

Creating, enrolling, restarting, rebuilding, revoking, or deleting a worker
does not disconnect chats on another worker. This also applies to
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
General-worker revocation marks the controller grant revoked immediately,
attempts the signed worker notice, and then invalidates its transport resources
even when notice delivery fails. Undelivered notices are persisted and retried
when connectivity returns, including after controller restart or registration
removal. Pending teardown retains outbound transport reachability only; it
does not restore execution, control-tool, or SSH-agent authorization. Once the
worker confirms cleanup, that transport identity is removed. Re-enrollment
cancels a queued notice for the previous registration.
Relay maintenance affects the routes using that relay, not direct workers or
workers using another relay. Switching the primary relay does not migrate
existing routes.

After a real interruption, native inputs are not automatically resent. Preserve
the worker data directory and original conversation binding for recovery;
creating a replacement worker does not transfer ownership of old sessions.

## Choose a topology

| Situation | Setup |
| --- | --- |
| The worker can reach the controller over HTTPS/WSS | Direct outbound worker |
| The controller is reachable only through a paired relay | Relayed outbound worker |

Run the generated `clanky worker join` command on a fresh worker to initialize
and enroll it. Discovery selects the controller or relay from the invitation;
there is no worker host, port, endpoint or certificate to configure.
Install/start its service explicitly afterward. Join does not install an OS
service or convert an existing controller data directory into a worker.

Optional `clanky worker bootstrap` configures an outbound-only worker before
joining. `--worker-directory` defaults to `$HOME` and `--instance-name` to the
short system hostname, capped at 64 characters; explicitly supplied names still
require 1-64 visible characters. `--outbound-only` makes the default explicit;
`--relay-only` retains its existing configuration meaning but now accepts either
invitation target. Both use a private loopback management API with an ephemeral
port.

Use HTTPS for controller, worker and relay Mesh endpoints, including during
local development. Plain HTTP listeners are only appropriate behind trusted
TLS-terminating proxies or for an outbound-only worker's private local API.

Direct outbound support is an opt-in Mesh v7 extension. Supporting workers
request it during discovery; the controller advertises it only to those
requests. An unsupported controller is rejected explicitly before enrollment,
not retried with a publicly exposed worker listener. Direct connections use
the controller's own signed identity and the existing authenticated control,
ticketed stream, route allowlist and execution gateway infrastructure. No
separate relay process or relay pairing is created on the controller.
Upgrade the controller before joining new outbound workers. Both endpoints
must retain binaries supporting this extension; older binaries do not
understand persisted outbound grants. Existing listener and relay routes
continue to use their negotiated Mesh v7 transport.

Persisted grants restore the outbound connections after service/controller
restart. Each direct controller grant has its own connection lifecycle;
existing relay association limits remain unchanged. Connection loss never
replays an enrollment token, command or prompt.

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

For TLS termination at a reverse proxy, configure `CLANKY_TRUST_PROXY=true`
(enabled in the production image), sanitize `X-Forwarded-Proto` and the other
configured forwarding headers, and keep the private HTTP listener inaccessible
to clients. `CLANKY_PUBLIC_BASE_URL` alone is not proof that a particular
connection used TLS. Do not forward caller-supplied forwarding headers
unchanged or use an HTTP proxy-to-relay link across an untrusted network.

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

## Existing listener-based direct workers

Existing direct registrations are not migrated on startup, binary update or
workspace restart/rebuild. Their controller still dials the enrolled HTTPS
worker endpoint. Preserve the data directory, identity, workspace binding and
working directory; do not delete or replace them to change a transport.
Migration is a separate explicit operation, not a prerequisite for using the
new binary. Dedicated worker grants remain workspace-managed and cannot be
converted into general workers with a global enrollment invitation.

Explicit listener-based bootstrap remains available for those installations:

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

## Bootstrap an outbound worker

Bootstrap is optional before a fresh join. Use it to customize worker defaults:

```bash
clanky worker bootstrap \
  --worker-directory /workspaces \
  --instance-name worker-1
```

These workers listen only on loopback with an ephemeral management port and
do not need a worker TLS identity or advertised endpoint. Their invitation
selects direct controller or relay transport. The controller's advertised
HTTPS endpoint must be reachable from a direct worker.

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
runtime, the workspace directory, and any other tools used by agents.

On Linux, installation creates systemd services. On macOS, it installs a
per-user LaunchAgent; the worker can request Accessibility, Screen Recording,
and Files and Folders permissions when those capabilities are used.

## Enroll a worker

Create a single-use invitation on the controller. Use `--route direct` to
connect the worker outward to that controller:

```bash
clanky mesh enrollment-token create --name worker-1 --route direct
```

To connect outward through a paired relay, use `--route relay`:

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

From the controller, use **Settings > Maintenance > Clanky workers > Update
all** to start one background job per active
Mesh worker, including workspace-exclusive automatic workers. The same owner-only action
is available through `POST /api/worker-update-jobs`; read progress and logs
with `GET /api/worker-update-jobs` and `GET /api/worker-update-jobs/:id`.

The worker update selector offers **Default**, **Stable** and **Latest**.
Default keeps each worker's saved channel. An explicit Stable or Latest choice
updates the binary and persistently changes that worker's default, including
automatic-workspace startup configuration. The confirmation remembers the
maintenance mode and the last explicit channel for new automatic workspaces.
Choosing Default later does not clear that inherited channel; it is Stable
until explicitly changed. Cancelling confirmation saves nothing.

Jobs run independently across workers. Restart requires confirmed update and
channel-save success; either failure skips the restart. Unsupported channel
configuration fails visibly rather than silently choosing another channel.
Default preserves legacy prerelease selections too.
Updating a workspace worker uses Mesh directly without reprovisioning or
restarting its container. Successful recovery requires a freshly restarted
worker running the installed version, not merely an old healthy process.

**Could not connect** means dispatch could not begin; **Failed** means a
confirmed failure; **Interrupted** requires confirmed termination.
**Not started** means no execution was dispatched. **Outcome unconfirmed**
means the result could not be verified. A lost response or controller restart
does not prove remote work stopped. Inspect the current state before retrying:
maintenance commands are never automatically replayed. Completed stages remain
recorded even if a later stage fails.
Jobs and their logs remain on the Dashboard until dismissed.

Unmanaged or unreachable workers report
an individual job failure rather than preventing other workers from updating.
Automatic workspaces without an enrolled Mesh worker are not update targets.
Use the workspace's individual **Restart** or **Rebuild** action for container
maintenance; both also install the current Clanky release of its selected
channel. **Update all** updates workers without container maintenance. The bulk
restart API remains available for explicit provisioning lifecycle operations.

Binary updates do not replace an automatic workspace's generated launcher or
supervisor scripts. To refresh those scripts in a managed environment after
upgrading the controller, use the workspace's **Restart** action in Clanky.
It publishes the current startup assets before starting the environment; a full
rebuild is not required just to refresh them. A raw Docker restart does not
publish new assets.

Use **Dismiss all** in the Dashboard's **Worker updates** panel to remove
terminal jobs and their logs after confirmation, even while other updates are
still in progress. Pending, connecting, running, and verifying jobs are kept
and do not prevent finished jobs from being dismissed. Individual jobs can
still be dismissed from their detail view.

## Automatic workspace runtimes

New automatic workers use outbound connections for both invitation routes.
Workspace creation selects **Worker connection**, not a worker address;
provisioning does not publish a container worker port.

Automatic workspace creation selects **GitHub Copilot**, **Codex**,
**OpenCode 2**, or **Claude Agent**. Native adapters require a
dedicated worker. The provisioning host can use local or Mesh execution independently of the container's
adapter.

Clanky uses Docker and the Dev Containers CLI directly. Install both on the
selected provisioning host; no external provisioning executable is needed.
Existing image/Dockerfile devcontainer definitions remain unchanged. Clanky
adds its runtime Feature through a private generated definition, preserving the
original build paths, Features, commands, mounts and environment. Docker Compose
definitions are rejected explicitly rather than rewritten. With no definition,
choose a language using `clanky environment templates`.

The tooling user comes from the merged project/image configuration. Clanky
does not override `remoteUser` or `containerUser` or change checkout ownership.
Standard Docker requires a checkout writable by that user. Rootless Docker is
also supported when Docker and the checkout share the same Linux provisioning
host: install the `acl` package (`getfacl` and `setfacl`) and use a filesystem
with POSIX ACL support. The workspace must bind-mount the selected checkout,
whose files must initially belong to the provisioning user.

Before project lifecycle commands run, Clanky resolves the rootless tooling
user's host identity and grants it the checkout owner's access using ACLs.
Existing identities retain their effective permissions; inherited ACLs share
new files between the host and tooling users without granting public access.
Explicit restrictive file creation modes still apply. Cached preparation is
bound to the checkout's filesystem identity; replacing the checkout prepares
the new directory without changing retained tooling-owned files. The checkout's
host group does not need to be mapped into the container.

Symlink targets outside the checkout, other mounts and foreign-owned files are
not repaired. Hard-linked files are rejected before ACL application because
their inode may also exist outside the checkout; initial provisioning clones
use `--no-hardlinks`. Missing prerequisites or incompatible ownership fail
explicitly instead of changing users, ownership or Docker configuration.
Clanky checks checkout and Git-directory write access as the tooling user
before reporting the environment ready.

A different non-root `containerUser` cannot switch to `remoteUser` at startup;
Clanky reports the limitation without elevating privileges. Explicit project
root settings are not silently changed.

Git author identity and the provisioning host's standard public `known_hosts`
entries are added without replacing the container user's existing entries.
Private SSH keys and SSH configuration are never copied. Custom SSH aliases or
nonstandard trust paths must be configured by the project.

The private `/var/lib/clanky` runtime points into the tooling user's home and
uses an environment-owned Docker volume outside the checkout. Its startup assets store the selected
adapter/provider and install only its current native CLI before starting the
worker. Node/npm must be available in the container.
Installation uses a private prefix, validates only that the
selected executable was installed, and adds a stable private bin directory to
the worker's PATH. Private runtime selection belongs to the current managed
supervisor; a separate worker on the same host keeps its own PATH even when
managed runtime assets are present. OpenCode 2 is exposed as `opencode2`, without
replacing a system OpenCode generation-1 executable. Claude Agent installs
`@anthropic-ai/claude-code` and exposes `claude`; authenticate the CLI on
the worker. See [Claude Agent setup](harnesses.md#claude-agent).
When npm requires install-script approval, it is recorded only for the selected
package in this private prefix; global npm policy is not changed.

Changing an existing automatic workspace's adapter installs the selected
dependency before saving settings and updates its durable requirements.
Failed installation leaves the saved selection unchanged. Runtime saves and
Clanky-managed rebuild/restart jobs are serialized per workspace. Previously
installed private runtimes remain cached; global packages and authentication
profiles are untouched. Authentication still needs to be configured separately.

Provisioning, rebuild and restart validate the environment and worker health,
not the native provider's connection or authentication. You can create the
workspace first and authenticate its provider later from a workspace terminal.
New terminals inherit the environment of their execution host or worker,
including provider profile paths, with Clanky's explicit per-session settings
applied afterward. This does not copy the controller or provisioning server's
environment into another execution host.
An unauthenticated provider does not remove an otherwise healthy workspace.

Deleting an automatic workspace removes its owned container on the provisioning
host before optionally deleting the source checkout. If container removal fails,
the workspace and checkout are kept so deletion can be retried after fixing
the host connection. Source deletion remains opt-in; private runtime credentials
are retained according to the default `environment remove` behavior.

Rebuild/restart preserve the current workspace runtime and private provider
profiles; [GitHub token refresh](#github-cli-credentials-in-automatic-workspaces)
still applies during rebuild. The additive Feature starts the worker as the
tooling user on every actual container start, including a raw Docker restart
without a controller connection. Original project startup still runs. Controller upgrades do not
install runtimes or rewrite remote startup assets; rebuild/restart or save the
adapter to update those assets.

Maintenance jobs distinguish connection failure before dispatch, returned
command failure, confirmed interruption, and an unconfirmed remote outcome.
If a restart/rebuild response is lost, Clanky verifies read-only environment status
and worker connectivity instead of resending the command. Automatic
workers also require installation evidence for that operation and fresh signed
health reporting the full installed build version; an old healthy worker alone
cannot confirm recovery. Missing evidence leaves the outcome unconfirmed.
A controller restart likewise does not prove that remote
execution stopped or authorize replay. Server `arise` jobs remain unconfirmed
when their result is lost because host reachability alone cannot prove that
the server update completed.

Automatic workspace creation offers the same channel selector.
Default inherits the user's saved channel from Maintenance, resolved when the
job is admitted. Selecting Stable or Latest overrides it only for that workspace.
The **Restart** and **Rebuild** views offer the selector under **Advanced
options**; Default preserves the existing workspace channel, while a forced
choice persists for future automatic starts and maintenance. Changing a runtime
adapter also preserves the saved channel.

Within a worker's execution environment, `clanky worker channel` reports its
effective default; `clanky worker channel stable` or `latest` changes it without
updating the binary immediately. `clanky update` then follows that saved
default. Automatic worker configuration lives in
`/var/lib/clanky/update-channel`; ordinary server workers keep it in
their Clanky data directory. Do not edit generated launcher scripts to override
this file.

Stable/latest bootstrap uses the shared GitHub installer and required SHA-256
checksums, with no cross-channel fallback. Every Clanky-managed **Restart** or
**Rebuild** resolves and installs the current release of the effective channel,
even when the cached binary already has that channel. Installation happens once
at container startup, before the worker loop is started; configuration
refresh then restarts that installed binary without downloading it again.
Successful maintenance requires fresh signed worker health matching the full
resolved binary version, not just its semantic-version prefix. Resolution,
download or checksum failures start the previously installed valid worker with
an explicit warning in the environment and maintenance UI. This is not a
successful update. Without a valid installed worker, startup fails visibly.
The replacement binary must report its version before publication.
Worker data, enrollment, runtime and the selected channel are preserved.

### Host-side recovery

Run these commands on the provisioning host; they do not depend on a healthy
dedicated worker or controller:

```bash
clanky environment list
clanky environment status --directory /path/to/checkout
clanky environment shell --directory /path/to/checkout
clanky environment stop --directory /path/to/checkout
clanky environment restart --directory /path/to/checkout
clanky environment rebuild --directory /path/to/checkout
clanky environment arise
```

For environments created by an account through the API, use its account ID
with `--owner`; `list --owner ACCOUNT_ID` reads that account's registry.
`arise` starts only recorded, ownership-verified stopped containers.
Restart and recovery run the project's `postStartCommand` through the Dev
Containers CLI, without simulating an editor attachment. Worker recovery
restores the project's resolved `remoteEnv` from private runtime state.
Use Rebuild after changing the devcontainer definition.
`remove` removes the owned container but preserves source and private state.
Only the separate explicit `--reset-credentials` choice also removes its
private volume. It never deletes the source checkout. Do not remove private
volumes merely to rebuild an environment.

Host-side restart/rebuild preserve the worker's live selected channel and
native adapter. Add `--release-channel stable` or `--release-channel latest` to
change the channel, or `--runtime-adapter codex` to select another native runtime.

Default Copilot, Codex, Claude and GitHub CLI profile directories also live in
the private volume, alongside Clanky's managed OpenCode profile. Image, Feature
and project profile environment settings remain authoritative, including empty
values. Projects choosing custom paths must provide their own durable mounts.
Clanky creates its default profile directories as the tooling user with private
permissions at each container start, without changing custom profile paths.
The tooling user's Git configuration trusts only the managed checkout before
project lifecycle commands run. This permits Git on Docker Desktop bind mounts
whose reported owner differs, without changing checkout permissions or trusting
other repositories.

### Worker process loop

New automatic worker workspaces use a persistent shell loop in
`/var/lib/clanky/supervisor.sh`. Ordinary launcher calls install Clanky
when missing or when its selected release channel changes; the maintenance
startup hook explicitly updates it first. The launcher then starts the loop in
the background. The loop runs the binary, waits for it to exit, and executes the
same path again. Installation and runtime package setup are outside the loop;
restarting the worker after an update does not download or reinstall anything.

The loop requires `flock` from util-linux in the container. A kernel-held lock
prevents duplicate loops and is released when the process exits. Worker output
and restart diagnostics go to `/var/lib/clanky/worker.log`. The loop keeps
retrying until explicitly stopped. It waits one second between normal launches;
repeated launches lasting less than five seconds increase that delay
exponentially up to 30 seconds rather than spinning. A run lasting at least five
seconds resets the delay.

An explicit start waits up to 40 seconds for a running worker, covering the
loop's maximum 30-second restart delay plus the usual 10-second startup budget.
An existing loop that is recovering or shutting down is not an immediate startup
failure. A failure to become running within that budget remains visible and
points to the worker log; repeatedly crashing binaries are not reported as
healthy merely because their loop exists.
If an intentional-stop marker remains while its owned loop is still alive,
an explicit start completes that stop before starting a replacement. It does
not clear the marker while the old loop owns the lock or start a second loop.

Inside the worker's execution environment, `clanky worker service status`,
`restart`, `stop`, and `start` control this loop instead of systemd. For direct
container administration, use:

```bash
sh /var/lib/clanky/supervisor.sh status
sh /var/lib/clanky/supervisor.sh restart
sh /var/lib/clanky/supervisor.sh stop
sh /var/lib/clanky/launcher.sh
```

`restart` terminates only the worker; the already-running loop starts its
replacement even if the Mesh connection disappears. `stop` records an intentional
stop, terminates the loop and worker, and waits for shutdown. Running the launcher
explicitly starts it again. A concurrent runtime exit does not make `stop` fail;
unreadable process identity files or failure to terminate a live process remain
errors. Provisioning cleanup stops the loop, and removing
the dedicated worker's last controller grant records a permanent stop before the
worker awaits its command cleanup and normal server shutdown, so retiring a
workspace cannot resurrect its runtime or leave its commands running.
Process checks distinguish the loop's `run` invocation from control commands
and confirm that its kernel lock is held, so persisted PIDs reused after a
container restart do not by themselves identify a live loop.
If the loop exits unexpectedly while its worker remains alive, startup refuses
to replace that worker. Run the supervisor's `stop` command before starting
the launcher again.

## GitHub CLI credentials in automatic workspaces

The default and recommended way to authenticate GitHub repositories in automatic
workspaces is **HTTPS with the GitHub CLI account already logged in on the
provisioning server**. On that host, authenticate `gh` and configure Git to use it:

```bash
gh auth login --hostname github.com --git-protocol https
gh auth setup-git --hostname github.com
```

Use an HTTPS repository URL such as `https://github.com/owner/repository.git`.
Leave **GitHub CLI account** empty to use the default account returned by
`gh auth token`, or enter an account name to use that account instead.
An explicitly selected name is saved for subsequent rebuilds.
For Mesh provisioning, this is the selected host that creates the container,
not necessarily the Clanky controller.

Every `environment up` and rebuild refreshes the imported token from that
account, including when using the default account. Switching the provisioning
host's active account or rotating its token is intentionally reflected on the
next up/rebuild; the previous default token is not pinned to the workspace.

Clanky imports that token into the workspace as `GH_TOKEN` for its worker and
interactive terminals. This lets `gh` and Copilot CLI reuse it without a second
login, provided the account/token has the required access. Clanky installs GitHub
CLI when needed and automatically configures the tooling user's GitHub HTTPS
credential helper after importing the token, so Git commands inside the workspace
use it too. No additional login or manual Git setup is required.

If you prefer SSH repository URLs, use the
[selected SSH-agent keys workflow](#selected-ssh-agent-keys) and choose the
keys to share during creation. HTTPS plus `gh` is the simpler recommended path;
SSH keys are an alternative for repository access, not authentication for Copilot
or another AI provider.

Without a default GitHub token, provisioning removes any previously imported
token, reports that no credentials were imported, and continues. It does not
fall back to a cached token. You can authenticate the native provider afterward;
other providers still need their own login. An explicitly selected GitHub account
must be available on the provisioning host. Private repository cloning still
requires working Git credentials or the selected SSH keys before the container
can be created.

The selected token is stored in the workspace's private runtime volume, not in
Git or public API responses, and restored into worker/shell environments on
container restart. Run only
trusted code in workspaces where this behavior is enabled, because terminal
processes can read inherited environment values.

## Troubleshooting checklist

- For outbound workers, confirm that the worker can reach the controller or
  relay endpoint. For existing listener-based workers, confirm that the
  controller can reach the worker endpoint.
- Use the exact HTTPS origin in the invitation or configured listener/pairing.
- Check that the reverse proxy forwards WebSocket upgrades.
- Verify the worker service runs as the account that owns its data directory
  and can find Git and the provider runtime.
- Revoke and enroll again after intentionally rotating a worker identity.
