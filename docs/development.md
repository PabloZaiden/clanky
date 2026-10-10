# Development

Clanky is a Bun application with an embedded server, web UI, CLI, and
standalone build.

## Set up a source checkout

```bash
git clone https://github.com/pablozaiden/clanky.git
cd clanky
bun install
```

Run the combined development server:

```bash
bun dev
```

The application is available at <http://localhost:3000>. Use an isolated
`CLANKY_DATA_DIR` for local experiments or visual validation.

## Build and test

Build the standalone artifacts and run the black-box E2E suite:

```bash
bun run build
bun run test
```

The build writes the production executable to `dist/`. Every automated test
starts that executable and interacts with it only through public CLI, HTTP,
WebSocket, WebDAV, process, filesystem, Git, or network boundaries. The suite
does not import application internals or inspect persistence.

The runner discovers only `tests/e2e/**/*.test.ts`, partitions those files from
their count and `CLANKY_TEST_MAX_WORKERS`, and never retries failures. Its
architecture guard rejects automated tests outside `tests/e2e`, production
source imports, in-process mocks or spies, route-handler harnesses, direct
persistence access, and production testing hooks.

Fail-fast budgets are 5 seconds for an individual request, command, local poll,
or WebSocket operation and 10 seconds for an asynchronous task, chat, agent,
SSH, provisioning, Mesh, startup, or recovery lifecycle. The 120-second
whole-journey limit remains only as a final backstop for slow CI. Successful
steps never wait out those budgets, and failures retain the named condition,
last observed state, and process logs.

Useful commands:

```bash
bun run typecheck
CLANKY_TEST_MAX_WORKERS=1 bun run test
bun run test:mesh
```

Provider-dependent E2E scenarios put deterministic provider executables first
in an isolated `PATH`. Clanky discovers and launches the fixtures in
`tests/e2e/providers/` through the same process, adapter, transport, and
lifecycle boundaries used for a real provider; production has no test-only
backend switch. The provisioning journey likewise invokes an external
deterministic `devbox` executable through real SSH and validates successful,
failed, cancelled, and restarted jobs at the public API boundary. Harnesses
allocate isolated data directories and ports, bound their polling, capture
subprocess logs for failure diagnostics, and clean up their process groups.

Voice E2E coverage uses an external HTTPS OpenAI-compatible provider and checks
settings, destination safety, capability validation, transcription, and
persistence. Positive Piper synthesis is intentionally not part of the
hermetic PR gate: a real run requires downloading or versioning roughly 90 MB
of checksum-pinned runtime and voice assets. Do not fake Piper by pre-populating
its private cache layout; use real assets for an optional manual smoke instead.

Add or change an automated test only for a considerable user, API, CLI, or
protocol workflow. Extend a compact journey instead of creating endpoint,
component, hook, class, or helper tests. UI-only behavior is validated manually
with `Bun.WebView`, not committed browser automation.

Run `bun run build && bun run test` before considering a change complete.

The complete Linux suite also starts an isolated OpenSSH server. Install
`openssh-server` and `sshpass` before running it; the harness creates its own
host key, client key, agent socket, port, configuration, and data directory.
It does not modify the user's SSH keys or contact an external host.

## Harness execution boundaries

`src/shared/harness-events.ts` is the canonical harness event contract. It is
distinct from scheduled Clanky Agent events. Every live event identifies its
principal or child scope; child output and failures must not enter the parent
transcript or complete the parent execution. Child permissions/questions retain
their origin and continue through the interaction coordinator.

`message.complete` closes one assistant message, not the logical prompt.
`prompt.complete` closes the principal prompt; `session.status: idle` alone does
not. Neither signal proves that descendant processes have exited. ACP translates
its explicit prompt terminal signal into the same contract; task execution
depends on the generic `Backend` port, not the `AcpBackend` class.

Test doubles at the harness seam must preserve these distinctions. Use HTTP
state/transcript observations to check them rather than asserting internal
translation calls.

`Backend.harness` is the session-lifetime control port. Capabilities distinguish
active-session steering from expected-turn admission, and native/partial activity
coverage from unavailable observation. An unavailable snapshot has no fabricated
empty activity list. Stop and owned-work settlement have separate confirmed,
pending and unknown outcomes; a cancellation acknowledgment is not confirmation.

Steering input IDs belong to Clanky's queue. Native admission/delivery identifiers
are recorded separately and used for recovery; an unknown admission must not be
blindly resubmitted. These controls do not imply that the model obeyed an accepted
message. ACP explicitly reports unsupported observation/steering rather than
emulating steering through cancellation and restart.

Native Copilot runtime/catalog collaborators live in `src/backends/copilot/`.
They use the installed execution-host CLI through explicit, attached SDK stdio,
not in-process FFI or a shared detached server. Startup checks authentication and
records the actual CLI/protocol version. Shutdown is awaited and idempotent;
cleanup failures preserve their causes.

Native executable discovery uses the configured execution-host `PATH`.
Codex's CLI version check receives the same environment and working directory as
its app-server process; it must not depend on the controller's global CLI path.

The catalog queries real native model/effort metadata, checks transport health,
rejects unavailable saved selections and leaves the profile's reasoning default
alone when no override was requested. Copilot's catalog namespace identifies its
serving harness, not an inferred model vendor. Workspace settings select ACP, native Copilot, Codex app-server or OpenCode
runtime 2. Existing workspaces migrate to ACP with their original harness
preset. Native execution uses local hosts or end-to-end Mesh v6 paths; every
controller, relay, and worker on the route must support v6. Direct SSH remains
ACP-only. Startup migration normalizes persisted Mesh protocol metadata to v6.
See [harness adapters](harnesses.md) for operational setup.

Codex reconciliation can query paginated history across the original thread when
an admission reply lost native references. The canonical input ID is the native
client ID, not evidence of delivery by itself; only a matching persisted native
user message confirms delivery. Recovery must not create a conversation or resend.

Task session lifecycle starts observation only after checkpointing the owned
binding, including uploaded-plan execution and cold reconnects. Engine-generated
initial goals retain deterministic IDs; queued/steered user messages retain the
queue input ID as their public message ID. This correlation also survives cold
delivery recovery.

Native registry payloads may disagree with SDK declarations. Normalize valid
nullable metadata at the adapter boundary, and validate activity projections
before storage; malformed observation must not overwrite unrelated input
receipts. Invalid persisted input history stays fail-closed rather than being
cleared by a fresh activity read.

Activity opens through the framework entity menu and retains the conversation
DOM, scroll, and composer draft on its canonical URL. An embedded task chat has a
separate **Chat activity** header action while its tab is visible, distinct from
the task execution's **Activity** action. Native tool rows link to their own scope.
Steer is a text-style action beneath queued input; admission, native delivery,
and model obedience remain separate.

## Markdown rendering validation

The file preview, chat messages, and agent logs share `MarkdownRenderer`.
Validate unsaved editor changes, undo after switching views, diagram errors,
raw-text mode, and theme changes with a temporary Bun.WebView harness. Capture
and review desktop and mobile screenshots; do not add browser or component
tests to the repository.

Mermaid is pinned to 11.16.1: the FastDOM dependencies in 11.17 conflict with
Monaco's global AMD loader. Before upgrading, render the first diagram **after**
Monaco has initialized and check both the development server and standalone
binary. Do not work around an incompatible dependency by changing the global
loader. The `.mermaid-measurement` container disables transitions so global
reduced-motion styles cannot interpolate SVG geometry during measurement.

## Demo data

The demo generator creates disposable data for UI validation:

```bash
CLANKY_DISABLE_PASSKEY=true \
  bun tests/test-data-generation/generate-demo-ui-data.ts \
  --data-dir /tmp/clanky-demo
```

Use a temporary data directory. The generator is intended for local
validation, not for production data.

## Release metadata

Release targets, binary artifacts, Docker platforms, and installer projections
are declared in `.github/release-metadata.json`. Check or regenerate the
generated installer metadata with:

```bash
bun run release:metadata:check
bun run release:metadata:generate
```

Edit the canonical release metadata, not the generated installer projection.
