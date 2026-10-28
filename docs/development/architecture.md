# Architecture and domain boundaries

Use this guide when changing server behavior, persistence, execution hosts,
backends, or realtime. Operational setup belongs in [deployment](../deployment.md),
[harness adapters](../harnesses.md), and [Mesh](../mesh-worker.md).

## Application and layer ownership

Keep Clanky as one Bun application and one binary: `clanky serve` runs the
server and `clanky <subcommand>` runs CLI operations. Do not add a separate
CLI binary, Vite server, or client development server.

The dependency direction is API -> Core -> Persistence:

- API modules validate and authorize requests, map domain outcomes to HTTP,
  and log request outcomes. They do not import persistence or mutate domain
  state directly.
- Core services own validation, state transitions, and orchestration. They
  may use persistence, but not API modules or HTTP response types.
- Persistence owns storage, not transport or request policy.

Browser/server-safe domain types and event contracts belong in `src/shared/`;
public request/response types and schemas belong in `src/contracts/`.
Contracts may depend on shared types, not the reverse. Keep implementation-only
types with their owner and do not add compatibility copies or parallel models.
Task status changes must use the canonical state machine rather than duplicate
transition rules.

Local CLI maintenance commands must not initialize the application server or
database unnecessarily. Load the server only for commands that need it and
share the asynchronous route-catalog loader with the Mesh CLI.

## Authorization and route contracts

Application data is private per user; new users start with empty Clanky data.
Declare authorization and same-origin policy on every framework route:

| Route | Authorization | Same-origin policy |
| --- | --- | --- |
| Private application route | `auth: "user"` | `sameOrigin: "mutations"` |
| Owner operation | `auth: "owner"` | `sameOrigin: "mutations"` |
| Raw WebSocket upgrade | Intentional user/owner policy | `sameOrigin: "always"` |
| Deliberately public route | `auth: "public"` | `sameOrigin: "never"` |

Public routes require a documented product rationale. Do not apply policy
through a global path allowlist, blanket rewrite, or method-based adapter.
Use framework ownership helpers for additional entity checks. Keep scopes,
schemas, descriptions, tags, and `cliPath` on the route definition; do not
maintain a parallel API/CLI catalog.

Await API operations before returning their result. Starting a long-running
task may return before completion only when its lifecycle owner handles errors,
persists failed state, and reports progress through public channels. Document
that intentional background lifecycle at the call site.

### Shared application control

Control contracts, direct intents, operation discovery/execution and human
interaction policy belong to the common control core, not Live Voice or a
provider adapter. Canonical framework route declarations remain the operation
inventory. Native tools, voice, MCP and deterministic runner IPC adapt that
core; do not duplicate domain transitions or launch an internal MCP server per
execution.

Resolve managed origin from persisted credential/execution associations.
Optional browser context supplies verified provenance and navigation, never
authority. Workspace grants permit project work, not workspace/access/host
administration. General grants stay within the real user's in-scope authority,
not wildcard scopes or a fabricated owner. Enforce the immutable grant ceiling
and current source authorization for discovery, referenced resources and every
dispatch, including after approval or private credential entry.
An ended Agent run cannot authorize further control or pending approvals, even
when its native conversation credential is retained.

Unsupported ACP model processes receive no automatic Clanky credential, even
when the workspace enables general control. Keep deterministic runner
credentials private across ACP prompts. Retire associated legacy nonterminal
wildcard keys and prevent their reissuance; do not change unrelated personal
keys or interactive terminal contracts.

Server control dispatch uses the framework's authenticated dispatcher with
mandatory operation admission, preserving current account checks and the
application's bound workspace authority. Do not forward unrestricted bearer
credentials or expose arbitrary user-ID impersonation over HTTP. Generic OAuth
and its persistence belong to the framework; Clanky validates workspace/general
selection and owns operation policy. See
[deployment and MCP authorization](../deployment.md#agent-control-and-mcp).

Nonvoice control sessions own bounded, expiring requests and private SSH
continuations. Return pending human interaction without blocking an unattended
agent indefinitely; the session owns detached work, cancellation and cleanup.
Only a separate real passkey-backed human interaction can approve frozen work
or supply a private credential. Pending requests are single-use and do not
survive restart. Credential tokens never enter tool results or deterministic
user code. Voice retains its existing call-bound presentation and direct paths.

## Execution hosts and workspace paths

Workspace paths refer to the selected execution host, not the Clanky server.
All repository/filesystem operations must use that host's `CommandExecutor`;
local `Bun.file`, filesystem calls, or shell commands are not substitutes.
Prefer the Git service for Git operations and specify the directory explicitly
with `git -C`.

Workspace IDs provide identity; directories are navigation starting points.
Use names in ordinary UI and show paths only for filesystem work or requested
diagnostics. A workspace directory or explorer root is **not a sandbox**.
Parent navigation, absolute paths, alternate roots, and existing symlink
semantics are intentional, subject to the host account's permissions. Do not
add containment or no-follow restrictions without approval for a separate
restricted-access feature.

This does not weaken authentication, user ownership, host selection, or managed
worktree ownership. Managed `.clanky-*` paths must come from the canonical
Git/worktree domain service, never caller-side concatenation. Construction,
ownership checks, lookup, and cleanup must use the repository directory on
the selected host.

When workspace and standalone SSH routes offer the same file operation, share
one transport-neutral implementation. Each route resolves its authorization,
credentials, executor, root, and response identifiers before delegating; do
not duplicate file logic or substitute local filesystem access.

## Service and backend lifecycles

`ChatManager` is an orchestration facade. Persistence/state writes, lifecycle,
workspace/worktree operations, backend/session ownership, streaming, and
interaction queues belong to their focused services. Do not reintroduce their
mutable maps, transport logic, or transition rules in the facade.

Backend adapters separate process/transport lifecycle, protocol sessions,
event translation, interactions, and provider/capability adaptation.
`AcpBackend` composes these collaborators and routes notifications; it does not
own process handles, protocol/session/run maps, or duplicate their logic.
Dependencies are one-way: collaborators must not call back into the facade.

Each mutable resource has one owner. Listeners, timers, subprocesses, requests,
subscriptions, permissions, and session state require deterministic cleanup on
success, failure, timeout, cancellation, process exit, disconnect, and reconnect.
All connection cleanup must be reachable from one teardown path. Bound
accumulated buffers and live connections, and clear losing timeout timers.

Optional ACP methods use the typed method-not-found helper; only
`acp_method_not_found` means capability absence. Preserve error codes and
details. Keep legacy event forms, ordered method fallbacks, and provider
adaptation documented at their narrow compatibility boundary rather than
scattering provider checks through transport/session code.

## Harness execution contracts

Harness events distinguish principal execution from child scopes. Child output
and failures must not enter the parent's transcript or complete its execution;
questions and permissions retain their origin.

`message.complete` closes a message, `prompt.complete` closes the principal
prompt, and idle status alone proves neither prompt completion nor descendant
process exit. Tasks depend on the generic backend contract, not an ACP class.
Shutdown records interruption before transport cleanup; interrupted planning
must remain recoverable, while provider exits outside shutdown remain failures.

Session control distinguishes steering from expected-turn admission, unavailable
observation from an empty activity list, and cancellation acknowledgement from
confirmed settlement. Unknown outcomes must not be presented as success.
Checkpoint owned session bindings before observation starts.

Clanky queue input IDs and native admission/delivery references have different
roles. Recovery confirms delivery from matching persisted native user input,
not from an admission reply alone. It must not blindly resend input or create
a replacement conversation. Preserve input correlation across cold recovery,
validate native metadata at the adapter boundary, and fail closed on invalid
persisted input history without overwriting unrelated receipts.

Native executables use the execution host's configured `PATH`, environment,
and directory, not the controller's global CLI installation. Native Copilot
uses attached SDK stdio, not in-process FFI or a detached shared server.
Startup checks authentication and actual CLI/protocol versions; shutdown is
awaited and idempotent. Catalogs query native model/effort metadata, check
transport health, reject unavailable saved choices, and preserve the profile's
reasoning default when no override was requested.

See [harness setup and supported transports](../harnesses.md) for provider
selection. Mesh compatibility changes follow the
[protocol evolution policy](../mesh-worker.md#protocol-evolution).

## Persistence and migrations

Evolve schemas through appended, sequential, idempotent migrations; do not
edit the consolidated base schema for ordinary evolution. Historical no-op
markers preserve deployed version history. Verify significant upgrade and
recovery contracts through the compiled application and public boundaries,
including a second restart when idempotency matters.

Use parameterized SQL and allowlists for dynamic identifiers, including
PRAGMA table names. Do not use `INSERT OR REPLACE`: its delete/insert behavior
can cascade into unrelated data. Use upserts. Decode persisted JSON with
validation and visible warning/error handling so corrupt data does not
silently become valid empty state or prevent unrelated records from loading.

Chat metadata and transcript collections have distinct owners and read paths.
Use metadata-only mutations when transcript bodies are unnecessary; do not
replace transcript counts with an unhydrated collection's length. Writes go
through the controller's state service, preserve execution-host/configuration
fields, and replace changed nested values rather than mutating input snapshots.
Transactional reads must not publish rolled-back cache state. Cache invalidation
must include deletion, ownership/host changes, and reset; external database
edits while Clanky runs are not a supported cache-coherent workflow.

For local profiling, the `clanky.chat-metadata-cache` diagnostics channel
publishes operation/count observations without retained history. Keep a
subscriber's channel reference alive; do not expose private cache state as
an API or test contract.

## Application realtime

Use framework resource publications for ordinary entity/collection invalidation
and `useLiveQuery` for reads, or `useRealtimeRefresh` for existing loaders.
Publications, including scheduled/background work, must target the authoritative
current user. Centralize resource names and retained stream classification at
the server realtime boundary.

Custom deltas are reserved for incremental task/chat/agent-run/provisioning
content where refetching is disruptive. Use bounded, no-history stream adapters,
versioned snapshots/deltas, and authoritative refresh after reconnects or gaps.
Take snapshot content and its position together from the domain owner, not a
delayed persistence checkpoint. Baseline reads follow subscription
acknowledgement; navigation/disconnect invalidate old reads. Supply identity
dependencies when changing entities.

There is no durable global replay log. Internal domain emitters are not a
browser transport or test contract. Do not add a duplicate invalidation path,
independent reconnect timers, fallback polling, or blind mutation replay.
Keep terminal, preview, and Mesh sockets as separate raw transports.

Keep last-loaded UI data during recoverable connection loss and refresh after
reconnection without global/per-resource error noise. Explicit operation
failures and terminal protocol/synchronization errors remain visible.
Sidebar activity uses compact metadata, not all transcripts. Live transcript
windows stay bounded; older history is explicit. Recovery replaces the loaded
window authoritatively, preserving its coverage rather than unioning stale
records. Public pagination options are in the [API reference](../API.md).

## Errors and logging

Classify domain failures by stable typed codes, not human-readable messages.
Preserve causes when wrapping. At HTTP/WebSocket boundaries, map known codes
to intentional safe responses and unknown failures to fixed generic 5xx
responses. Client recovery branches on public codes/status, not message text.
Reuse the shared API response and error-mapping helpers.

Make failures visible without double-reporting them. Transient user feedback
uses framework notifications; persistent page/form failures stay inline.
Do not swallow errors or substitute success-shaped defaults.

Log unrecoverable/unexpected server failures at `error`, expected client 4xx
outcomes and recoverable failures at `warn`, milestones and non-failure
redirects at `info`, control flow at `debug`, and detailed diagnostics at
`trace`. Prefer one failure log at the responsible boundary; lower layers
should add context, not repeat it. Never log credentials or raw secret payloads.

## Proportional concurrency

Clanky is primarily single-user, with occasional collaboration. Before adding
locks, queues, reservations, generations, retries, reconciliation, or a
concurrency review finding, identify independent producers, a plausible
supported overlapping workflow, and its likelihood and user-visible impact.
A possible ordering across an `await` is not enough.

Rare, low-impact conflicts between manual actions may fail visibly and be
retried by the user. Reuse existing lifecycle coordination rather than adding
another queue. Preserve safeguards where provider events, background tasks,
transports, navigation, or shutdown really overlap, especially for data
integrity, authorization, irreversible operations, host identity, and cleanup.
