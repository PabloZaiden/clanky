# Testing and validation

Clanky's automated suite is a compact catalog of required product scenarios,
not a history of bugs. Visual-only behavior is validated manually.

## Build and run

For application changes, build the standalone artifacts and run the suite:

```bash
bun run build && bun run test
```

Use `bun run test`, not `bun test` directly: the runner discovers and
orchestrates the supported E2E scenarios and enforces their architecture.
Do not declare application work complete while required E2E is failing.
Documentation-only changes need link/content review, not an application build
or E2E run.

Useful narrower checks during development:

```bash
bun run typecheck
CLANKY_TEST_MAX_WORKERS=1 bun run test
bun run test:mesh
CLANKY_LOG_LEVEL=info bun run test:mesh
```

The Linux suite requires `iproute2`, `openssh-server`, `sshpass`, `dtach`, and
`util-linux`. Automatic Devbox workspace scenarios require `flock`
(`util-linux` on Linux, `brew install flock` on macOS).
Install prerequisites before running the relevant journey.

The voice-provider fixture requires OpenSSL and listens on an ephemeral HTTPS
loopback port. Its certificate is trusted only by the isolated Clanky process;
it needs no network aliases or elevated privileges.

## Decide whether a scenario belongs

Add or materially change E2E only for a considerable change to an observable
user/integration workflow: lifecycle, authorization/isolation, persisted data
and recovery, filesystem/Git/process effects, protocols/transports, or packaging.
An implementation change alone does not justify test churn.

Before changing coverage, record:

1. The real-world user or integration workflow Clanky must support.
2. The public boundary it traverses.
3. The required observable result or external effect.
4. Why it belongs in the compact suite and is not already covered.

Prefer a few broad, coherent journeys and extend an existing one when failures
remain diagnosable. Apply the decision gate to **each action and assertion**:
it must advance the workflow, establish a necessary precondition, verify a
required outcome, or clean up resources.

A bug report and approval to fix it do not independently approve a product
scenario. Ask: **if the defect had never existed, would we still require this
workflow and these assertions?** If the rationale depends on the defect, do
not add or retain the coverage. Remove regression-only steps and their
exclusive stimuli, fixtures, and helpers after fixing the defect; do not
rename them or move them into a broader journey.

Reproduce defects with disposable local scripts separately from committed
coverage, and remove those artifacts after investigation. If a missing product
scenario emerges, obtain independent approval and implement its smallest
coherent journey, not the reproduction matrix.

Do not manufacture concurrency barriers, cross-client permutations, repeated
near-limit payloads, exact session comparisons, or no-op lifecycle steps just
to preserve a past failure. Exact output/absence assertions belong only where
required by an external protocol, security, compatibility, validation, or
data-safety contract. Internal refactors, helpers, copy, DOM, CSS, hook plumbing,
and removed implementation details do not independently merit tests.

## Black-box boundaries

All committed automated tests belong under `tests/e2e/` and start or connect to
the compiled `dist/clanky` and its real WebApp server. Interact through public
CLI, HTTP, WebSocket, WebDAV, filesystem/Git effects, or real network protocols.
Assert user-visible outcomes, including restart behavior when persistence or
recovery is the contract.

Do not add unit, component, hook, repository, handler, in-process API/integration,
or browser automation tests. Tests/support must not import application
internals, invoke handlers, inspect SQLite as an assertion surface, inject
managers/executors, use testing hooks, or assert private state/call order.
Do not replace these with another regression layer.

## Real processes and deterministic providers

Committed E2E must not require live AI providers, external credentials, quotas,
or model output. Put deterministic provider executables in an isolated `PATH`
or use an external network service. Clanky must discover and invoke them
through production command resolution, adapters, stdio/RPC, HTTP, SSH, or Mesh,
not injected backends or test-only production switches.

Mocks may model streaming, tools, questions, permissions, failure, cancellation,
reconnect, and session loss. Assert Clanky's public results and effects, not
mock internals/counts. Other unavoidable third-party seams use the same
external-process rule. Use real Git repositories/remotes, Clanky Mesh processes,
and an ephemeral SSH server.

Provider waits for future user input belong to the turn lifecycle and end on
input, interruption, deletion, or closure. Do not expire them with a separate
provider timer while the journey prepares input.

Positive Piper synthesis is an optional manual smoke requiring real downloaded
assets, not part of the hermetic gate. Do not fake it by pre-populating a
private cache layout.

## Isolation, synchronization, and cleanup

Each journey owns isolated data directories, homes, repositories, ports,
credentials, sockets, and subprocesses. Use `CLANKY_DISABLE_PASSKEY=true` for
unattended scenarios except those verifying authentication boundaries.
Never modify the developer's data or SSH keys, or contact an external host.

URL-fetch journeys that must validate a public destination use a dedicated
Linux network namespace with no external interfaces or default route. A
globally routable test address may be assigned to loopback inside that
namespace for a local HTTP fixture; run the fixture, compiled application,
and E2E client in the same namespace. The runner uses an unprivileged user
namespace where available; if the kernel disables those, it uses noninteractive
sudo to create only the network namespace, then drops to the original test UID
and GID before starting the E2E process. Keep production address validation
unchanged and never send fixture traffic outside the namespace.

Fixed delays are not synchronization. Wait for health, public state, frames,
process completion, or filesystem/Git effects with a bounded named condition
and last-observed-state diagnostics. Keep timers only where time itself is
the contract; do not retry or lengthen sleeps to hide failures.
For terminal commands, wait for the expected execution result, not a marker
also present in echoed input.

| Operation | Budget |
| --- | --- |
| Individual request, command, local poll, or WebSocket operation | 5 seconds |
| Async task/chat/agent/SSH/provisioning/startup/recovery lifecycle | 10 seconds |
| Mesh E2E operation (`MESH_OPERATION_TIMEOUT_MS`) | 20 seconds |
| Whole journey, final slow-CI backstop | 120 seconds |

The Mesh exception covers bootstrap, enrollment, HTTP/health, remote commands,
and the external Devbox fixture. Keep existing
lifecycle/polling, startup, large-image, and whole-journey budgets;
the exception does not change production or non-Mesh timeouts.

Use shared polling/timeout helpers in `tests/e2e/support/`. Preserve original
errors and report relevant Clanky/provider logs (including before restarts),
last public state, process status, and Git state. HTTP diagnostics include
method/path and causes, not bodies, credentials, or query parameters.
Teardown awaits all cleanup and leaves no child processes, sockets, worktrees,
or temporary directories.

Derive concurrency from discovered E2E files and `CLANKY_TEST_MAX_WORKERS`.
Do not maintain per-file runtime weights, arbitrary shard counts, or retries;
serialize only for a documented resource/isolation constraint.

Discover the current Git branch instead of assuming `main` or `master`.
SSH fixtures keep isolated `HOME`, provider `PATH`, and `/bin/sh` in a single
OpenSSH `SetEnv` directive: subsequent directives are ignored. Do not source
the host account's interactive shell initialization.

## Manual visual validation

Use `Bun.WebView` from Bun 1.4+ as a disposable development tool, not committed
test infrastructure. Validate each UI change on desktop and mobile and review
one screenshot from each; document why if capture is unavailable. Design
dark-first and check light mode while preserving saved Light/System choices.

Use isolated `CLANKY_DATA_DIR` and disable passkeys only for local unattended
flows that are not testing authentication. Keep browser harnesses, screenshots,
manifests, and review notes in ignored/disposable storage, not committed assets.
See [UI validation and demo data](webapp.md#visual-validation) and the
[WebView workflow](../../.agents/skills/webapp/SKILL.md#headless-browser-validation-with-bunwebview).

For video-only work, use the
[fframes media validation workflow](../../.agents/skills/fframes-video/SKILL.md#3-the-loop),
not automated tests or test-harness changes. Application code changes still
require the build and E2E checks above.
