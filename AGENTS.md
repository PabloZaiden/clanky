# AGENTS.md - AI Coding Agent Guidelines

This document provides guidelines for AI coding agents working on the Clanky project.

## General Agentic Workflow

When working on tasks, follow this general workflow to ensure clarity and goal alignment:

- Always make sure you have all your goals written down in a document in `./.clanky-planning/plan.md` and agreed upon before starting to code.
- Always use the `Todo` functionality to keep track of the work you're doing, and the last `Todo` should always be "verify that all goals are met according to the document, and update the `Todo` again". Use `./.clanky-planning/status.md` to track the plan status.
- Track the status of the work in that document.
- After checking the document, update what the next steps to work on are, and what's important to know about it to be able to continue working on it later.
- Make sure that the goals you are trying to achieve are written down, in a way that you can properly verify them later.
- When you need to fix a bug, first make sure you can reproduce it locally unless the user is explicit that reproduction is not needed. Trying to fix a bug before reproducing it can make things worse.
- When you need to see how something works or looks in the UI, use `Bun.WebView` from Bun 1.4+ for manual browser validation during development.
- Do not add browser automation tests to this repository; prefer lower-level automated tests and keep `Bun.WebView` as a development tool rather than a committed test layer.
- Tasks that involve UI changes or adjustments must finish, whenever possible, with one desktop screenshot and one mobile screenshot for each UI change made. If screenshots cannot be captured, document why.
- Don't say something is done until you have verified that all the goals are met.
- The general task then is:

  1. Write down the goals you want to achieve.
  2. Write the code to achieve those goals.
  3. Verify that all the goals are met.
  4. Update the document with the status of the work.
  5. If all goals are met, you are done.
  6. If not, go back to step 2.

## Project Overview

Clanky is a full-stack Bun + React application for controlling and managing Clanky Tasks through ACP-compatible agent backends (Codex, Copilot, OpenCode, Claude, Pi, or Grok). It uses Bun's native bundler and server, React 19 for the frontend, Tailwind CSS v4 for styling, and `@pablozaiden/webapp` for shared app foundations.

For more project information, see the [README.md](README.md).

## Webapp framework migration rules

- Prefer `@pablozaiden/webapp` primitives for auth, passkeys, API keys, device auth, same-origin checks, app shell, sidebar, settings, realtime, server health, and server lifecycle actions.
- Use the webapp public `useTheme()` hook for JavaScript integrations that need preference or resolved theme state. Never observe or mutate framework-owned root classes or DOM nodes to infer the resolved theme; prefer CSS theme variants when JavaScript state is unnecessary.
- Keep Clanky as one app and one binary. Use `clanky serve` for the server and `clanky <subcommand>` for CLI commands; do not reintroduce a separate `clanky-cli` binary.
- Use `bun --hot src/index.ts serve` for development; do not add Vite, a separate web dev server, or `CLANKY_WEB_DIST_DIR` for dev.
- Treat app data as private per user. New users start with empty Clanky app data.
- Use app-owned websocket upgrade/proxy handlers only for raw transports such as SSH terminal, VNC, and preview bridges. Do not retain or add normal app-state event subscriptions in raw transport handlers; normal app-state updates should use framework realtime.
- Use framework resource events (`publishChanged`, `publishEntityChanged`, and `publishDeleted`) plus `useRealtimeRefresh` for ordinary private entity and collection invalidation. Resource publications must target the authoritative current user, including background and scheduled work.
- Keep custom framework realtime events only for incremental task, chat, agent-run, or provisioning deltas that would be unnecessarily expensive or disruptive to recover with a full refetch. Use a narrow no-history stream adapter, bound accumulated browser state, and refresh authoritative state after reconnects or delta gaps; do not recreate a global event history or duplicate invalidation path.
- Keep resource event names and retained stream classification centralized at the server realtime boundary. Internal domain event emitters may remain for orchestration and tests, but they are not a browser transport contract.
- Add route metadata directly to framework route definitions when API/CLI discovery is needed; do not maintain a separate hand-written route catalog unless it is a temporary migration bridge.
- Use framework settings for generic theme, log level, passkeys, device sessions, API keys, users, and server operations. Keep only Clanky-specific settings in app-owned settings sections.
- Consume framework-owned client log-level state and adapt it to Clanky's logger. Do not fetch webapp configuration from app-local initializer components or duplicate settings state.
- Route components rendered by `WebAppRoot.routes` must use `Page` as the top-level wrapper. Do not render content directly into `.wapp-main-content`, recreate shell spacing, or duplicate the fixed framework title with an app-local heading.
- Prefer framework main-content primitives (`Page`, `Panel`, `DataList`, `DataListRow`, `FormGroup`, `FormActions`, `DangerZone`, `LoadingState`, `ErrorState`, `CodeValue`) before custom CSS. Use `EntityHeader` only for entity-specific headings that are distinct from the fixed title bar.
- Keep operational screens concise: use labels, values, actions, statuses, errors, and actionable warnings instead of explanatory paragraphs about workflow mechanics, navigation, persistence, or job retention. Add helper text only when it is needed to enter valid or safe data or to explain an irreversible consequence.
- Use the webapp notification service for transient feedback. Do not add
  Clanky-owned toast providers or wrappers. Use inline `ErrorState`/validation
  for persistent page state and avoid reporting one failure twice.
- Use route-backed `SidebarNode.actions` for task, chat, agent, SSH session, workspace and server commands. The framework owns both sidebar context menus and active title-bar three-line menus; do not reintroduce Clanky-local shell/header action menus.
- Use framework dialogs/modals/action menus for generic UI behavior. Framework dialogs handle Enter/Escape, destructive/delete menu items are red and last, and sidebar badges render as compact status dots.
- Use structured `settings.sections[].rows` for app settings with an explicit
  `user`, `admin`, or `owner` scope. Put selectors and toggles in row
  `content`, ordinary operations in row `actions`, and destructive operations
  in row `danger` presentation with framework confirmation. Use custom `render`
  sections only when the framework row model cannot represent the setting, and
  add a nearby code comment explaining every remaining limitation.
- Header action buttons must remain visible and non-deforming; titles/subtitles should truncate before actions are clipped.
- Never query or portal into framework-owned shell DOM nodes. Titles and
  actions must come from route-backed `SidebarNode` data or documented
  `WebAppRoot.header` APIs. If a generic header capability is missing,
  implement it in `@pablozaiden/webapp` before adding an app workaround.
- Use `WebAppRoute` from `@pablozaiden/webapp/web` as the only canonical
  client route model. Do not add app-owned route unions, hash parsers,
  serializers, conversion layers, or direct hash mutation; use the framework's
  route state and navigation helpers. When replacing undocumented routing
  compatibility, remove the legacy shape rather than translating or
  redirecting it.

## Authentication & Authorization

Clanky is typically deployed behind a reverse proxy that enforces authentication and authorization. Application-level authentication is handled through passkey-backed browser sessions and bearer tokens. This means:

- API endpoints do not require session management inside Clanky itself
- Destructive endpoints (server kill, database reset) should still be protected by the reverse proxy or by the application auth layer
- WebSocket connections can be protected either at the proxy layer or by the application auth layer

The production Docker image assumes a reverse proxy and enables
`CLANKY_TRUST_PROXY=true` with `proto,host,prefix` forwarding headers and the
`first` chain policy. Public deployments must sanitize those headers at the
proxy, set `CLANKY_PUBLIC_BASE_URL` to the external absolute HTTPS origin
without credentials, a path, query, or fragment, forward WebSocket upgrades,
keep port `8080` private, and persist `/app/data`.

### Testing without passkeys

For unattended local browser validation, start Clanky with `CLANKY_DISABLE_PASSKEY=true` so the framework bypasses interactive passkey setup while preserving the normal browser/API surface:

```bash
CLANKY_DISABLE_PASSKEY=true CLANKY_DATA_DIR=/tmp/clanky-passkey-disabled bun src/index.ts serve
```

Use an isolated `CLANKY_DATA_DIR` when creating validation data so local user data is not modified. Keep passkey enforcement enabled for tests that explicitly verify passkey registration, login, deletion, or auth boundaries.

## Remote Command Execution Architecture

**CRITICAL: All operations on workspace repositories MUST be executed through `CommandExecutor` on the workspace host (local for `stdio`, remote for `ssh`), NEVER through direct filesystem assumptions in the Clanky process.**

Clanky can connect to ACP runtimes across different environments (local host via `stdio`, or remote machines via `ssh`). Workspace directory paths (like `/workspaces/myrepo`) always refer to the selected workspace host for that transport, not implicitly to the Clanky server filesystem.

### How to Execute Commands on Workspace Hosts

Always use the `CommandExecutor` interface to run commands on the selected workspace host:

```typescript
// Get a command executor for a workspace
const executor = await backendManager.getCommandExecutorAsync(workspaceId, directory);

// Execute git commands - always use -C flag to specify directory explicitly
const result = await executor.exec("git", ["-C", directory, "status"]);

// Use GitService for git operations (preferred - provides better encapsulation)
const git = GitService.withExecutor(executor);
const isRepo = await git.isGitRepo(directory);
const branch = await git.getCurrentBranch(directory);
```

### What NOT to Do

```typescript
// WRONG - runs locally, will fail for remote workspaces
import { existsSync } from "fs";
if (existsSync(directory)) { ... }

// WRONG - runs locally, directory may not exist on Clanky server
await Bun.$`git -C ${directory} status`;

// WRONG - checks local filesystem
const file = Bun.file(path);
if (await file.exists()) { ... }
```

### What to Do Instead

```typescript
// CORRECT - runs on the selected workspace host via CommandExecutor
const executor = await backendManager.getCommandExecutorAsync(workspaceId, directory);
const exists = await executor.directoryExists(directory);
const result = await executor.exec("git", ["-C", directory, "status"]);
const content = await executor.readFile(path);
```

### Available CommandExecutor Methods

- `exec(command, args, options?)` - Execute a shell command
- `fileExists(path)` - Check if a file exists
- `directoryExists(path)` - Check if a directory exists
- `readFile(path)` - Read a file's contents
- `writeFile(path, content)` - Write content to a file (uses base64 encoding for safe transfer)
- `listDirectory(path)` - List files in a directory

### Shared transport-neutral operations

When workspace and standalone SSH-server routes expose the same domain operation, implement that operation once against a transport-neutral interface such as `CommandExecutor`. Route adapters should resolve their own authorization, target, credentials, executor, and root, then delegate the common operation to the shared core service. Do not duplicate file-operation logic or bypass the selected host with local filesystem access; preserve each adapter's ownership, credential, and response-identifier rules at the route boundary.

### Managed workspace paths

**Managed workspace paths and directory names must be defined by one domain service. Callers must not concatenate `.clanky-*` paths themselves, and path checks for workspace repositories must execute through the selected host's `CommandExecutor`.**

Use the Git/worktree service's canonical managed-path helpers for task and chat worktree construction, ownership validation, lookup, and cleanup. Keep path construction explicit about the repository directory and do not use local Clanky-server filesystem checks for workspace repositories.

### Chat core service boundaries

`ChatManager` is an orchestration facade, not a second domain implementation.
Keep chat persistence/state writes, lifecycle workflows, workspace/worktree
operations, backend/session ownership, conversation streaming, interaction
queues/permissions, and chat-to-task conversion in their focused core
services. The facade may coordinate cross-service workflows and preserve its
public API, but must not reintroduce service-owned mutable maps, duplicate
state-transition rules, or direct persistence/transport implementations.
Service dependencies must remain one-way and transport-neutral; workspace
repository operations continue to use the selected host's `CommandExecutor`.

### Backend adapter boundaries

Backend adapters (e.g. the ACP backend under `src/backends/acp/`) must separate
process/transport lifecycle, JSON-RPC protocol sessions, event translation,
permission/question coordination, and provider/capability adaptation into
focused collaborators with strictly one-way dependencies. `AcpBackend` is a
stable facade that implements the public `Backend` contract by composing those
collaborators, routing inbound notifications, and orchestrating connection-level
teardown; it must not own protocol maps, process handles, session/run maps, or
duplicated domain logic, and no extracted collaborator may import or call back
into the facade.

Every mutable resource has exactly one explicit owner with deterministic
cleanup of listeners, timers, subprocesses, pending requests, subscriptions,
permission requests, and per-session state on success, error, timeout,
cancellation, process exit, disconnect, and reconnect. All cleanup must be
reachable from the single connection-teardown path. Optional ACP methods flow
through one typed method-not-found helper (`optional-method.ts`) that treats
only `acp_method_not_found` as capability absence and preserves protocol error
codes/details; never centralize backend behavior in one class.

Record intentional compatibility shims (legacy ACP event forms such as the
legacy SDK `translateEvent`, ordered method-name fallbacks, and
provider-specific adaptation behind the capability table) at their narrow
boundary rather than scattering provider checks through transport or session
code.

### TypeScript

- **Strict mode is enabled** - respect all strict checks
- Use inline type annotations for function parameters
- Use generics for React hooks: `useRef<HTMLElement>(null)`
- Use `as` for type assertions: `formData.get("key") as string`
- Use `Partial<T>` for optional config objects
- Non-null assertions (`!`) are acceptable when the value is guaranteed
- **Use bracket notation for index signatures**: `process.env["VAR"]` not `process.env.VAR`

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| React Components | PascalCase.tsx | `App.tsx`, `APITester.tsx` |
| TypeScript files | lowercase.ts | `index.ts`, `build.ts` |
| Functions | camelCase | `testEndpoint`, `parseArgs` |
| Variables | camelCase | `responseInputRef`, `formData` |
| Type declarations | kebab-case.d.ts | `bun-env.d.ts` |

### Error Handling

Use try/catch with String conversion for error display:

```typescript
try {
  const data = await res.json();
  // handle success
} catch (error) {
  console.error(String(error));
}
```

### Async Patterns

Use async/await consistently:

```typescript
async GET(req) {
  return Response.json({ message: "Hello" });
}

const handler = async (e: FormEvent) => {
  const res = await fetch(url);
};
```

**CRITICAL: Always await async operations in API handlers.** Never use fire-and-forget patterns like `.then()` or `.catch()` without `await` in API route handlers. The API response should only be sent after all operations complete:

```typescript
// WRONG - fire and forget, errors are silently swallowed
async POST(req) {
  engine.start().catch((error) => log.error(error));
  return Response.json({ success: true }); // Returns before start() completes!
}

// CORRECT - await all async operations
async POST(req) {
  try {
    await engine.start();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: String(error) }, { status: 500 });
  }
}
```

**Exception for long-running processes:** Fire-and-forget is acceptable when starting a long-running process that:
1. Runs for an extended duration (minutes to hours) where blocking the HTTP response is impractical
2. Has comprehensive self-contained error handling (try/catch, state updates to "failed", error event emission)
3. Reports progress and errors through alternative channels (event emitters, persistence callbacks, WebSocket events)
4. Documents the pattern explicitly with inline comments explaining the design decision

Example: `engine.start()` in `TaskManager.startTask()` uses fire-and-forget because the task engine runs a `while`-task with multiple AI iterations that may take hours. The engine has its own `handleError()` method that updates task state to "failed" and emits error events. Awaiting would block the API response indefinitely.

### React Components

- Use functional components only (no class components)
- Define components as function declarations, not arrow functions
- Use Tailwind CSS utility classes inline

```typescript
export function MyComponent() {
  return (
    <div className="max-w-7xl mx-auto p-8">
      {/* content */}
    </div>
  );
}
```

### Comments

- Use JSDoc blocks for file-level documentation
- Use inline comments for context and explanations
- Generated files should include origin comment

```typescript
/**
 * This file handles the main application logic.
 */

// App-specific API routes live here; the framework owns the web document route.
"/api/example": route,
```

### Formatting

- 2-space indentation
- Double quotes for imports
- Template literals for string interpolation
- Trailing commas in multiline structures

## API Routes

Define routes in `src/api/` modules using Bun's route-based API. Every
`defineRoutes` entry must declare its intentional authorization and same-origin
policy directly on the route. Normal private Clanky routes use
`auth: "user"` with `sameOrigin: "mutations"`; owner-only operations use
`auth: "owner"`. Raw websocket upgrades should use `sameOrigin: "always"`.
Public routes are exceptional and must explicitly use
`auth: "public", sameOrigin: "never"` with a documented product rationale.
Keep scopes, schemas, descriptions, tags, and `cliPath` on the same route
definition so the framework catalog and CLI discover the complete contract.

Do not apply authorization or same-origin policy through a global path
allowlist, blanket route rewrite, or method-based adapter. Handlers should use
`ctx.requireUser()`, `ctx.requireOwner()`, `ctx.assertUser()`,
`ctx.filterOwned()`, and `ctx.requireOwned()` when an additional ownership
check is needed; route policy remains the framework's declarative boundary.

```typescript
import { defineRoutes } from "@pablozaiden/webapp/server";

export const myRoutes = defineRoutes({
  "/api/endpoint": {
    auth: "user",
    sameOrigin: "mutations",
    async GET(req) {
      return Response.json({ data: "value" });
    },
    async POST(req) {
      const body = await req.json();
      return Response.json({ received: body }, { status: 201 });
    },
  },
  "/api/endpoint/:param": {
    auth: "user",
    sameOrigin: "mutations",
    async GET(_req, ctx) {
      return Response.json({ param: ctx.params["param"] });
    },
  },
});
```

Routes are aggregated in `src/api/index.ts` and spread into the server.

## Bun Specifics

This is a Bun-only project. Never check if something might not be supported in another environment. You can assume Bun is always available.

Always use Bun features and APIs where possible:

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## APIs

- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Use `Bun.$` for shell commands instead of execa (for local server operations only — workspace repository commands must use `CommandExecutor`, see Remote Command Execution above)

```typescript
// File operations
const file = Bun.file("path/to/file");
const content = await file.text();
await Bun.write("path/to/file", content);

// Shell commands (local server operations only, NOT for workspace repos)
const result = await Bun.$`ls -la`.text();
```

## Testing

First of all, remember to run `bun install` when working on a new task, to make sure all dependencies are installed.
Always run `bun run build` before running tests, to make sure there are no build errors.
Use `bun run test` to run all the tests. Don't do `bun test` directly, since the script cleans a lot of the logs that add noise to the tests.

Always run `bun run build && bun run test` when you think you are done making changes.
Never say a task is done when there are still failing tests, even if you think they're unrelated to your changes.

### Test orchestration

Test orchestration must not rely on manually maintained per-file runtime
weights or arbitrary fixed shard counts. Prefer deterministic generic
partitioning and serialize only for documented resource/isolation constraints.
`CLANKY_TEST_MAX_WORKERS` is the primary setting for test worker capacity;
derive each suite's shard count at runtime from its discovered file count and
that capacity rather than maintaining a separate shard-count configuration.

```typescript
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

### Test decision gate

Prefer no test over a low-value test. Before adding, retaining, or
substantially changing a test, record the concrete regression it catches, the
public boundary or justified pure contract it exercises, why a
behavior-preserving refactor should not invalidate it, and whether equivalent
coverage already exists. Delete or rewrite the test when any of those answers is
missing.

Use the highest practical public boundary:

- API tests should exercise real HTTP requests, persistence, workspace effects,
  authorization, and observable responses.
- Integration/user-scenario tests should cover workflows crossing subsystems,
  including task/chat/workspace lifecycle, Git, branch safety, SSH, Mesh,
  provisioning, and review cycles.
- E2E tests should be sparse and exercise the real application boundary.
- Unit tests are exceptional and must protect a small, stable security,
  data-safety, migration, containment, protocol, scheduling, cancellation, or
  lifecycle contract that is impractical or unsafe to prove publicly. Add a
  short rationale beside every non-obvious exception.

Tests must assert behavior, not implementation. Do not test private fields,
maps, refs, counters, helper results, event ordering, internal state
transitions, or implementation-only sequences. Do not test mocks or fakes:
call counts, call order, configured return values, and delegation are not
contracts. Use deterministic local doubles only at genuine external seams and
assert the resulting public response, persisted state, filesystem effect,
process cleanup, or protocol payload.

Do not add tests for internal prompt wording, headings, logs, generated
SQL/GraphQL/request construction, generated code, error-message composition, or
other exact text when stable status, structured data, or an external protocol
is sufficient. Exact text is valid only when required by an external protocol,
security boundary, or explicitly documented compatibility contract. Do not add
tests for UI copy, labels, punctuation, DOM structure, CSS classes, fetch/click
plumbing, modal mechanics, accessibility wording, or visibility-only behavior.
UI-only changes should be validated manually when needed; do not add frontend
component or hook tests.

Never add a test whose primary purpose is proving that a removed table, field,
route, option, label, or behavior is absent. Keep a negative assertion only
when absence is itself an explicit security, containment, compatibility,
validation, or data-loss contract, and explain non-obvious cases next to the
test. Do not duplicate one rule across API, integration, and E2E layers.
Retain lower-level coverage only for a distinct status/error contract,
security boundary, state transition, data-safety property, external protocol
guarantee, or cleanup behavior that the higher boundary cannot prove.

Tests must be deterministic. Fixed delays are not synchronization: use explicit
deferred signals, server/stream/process completion, emitted events, or bounded
polling of named observable state with last-observed-state diagnostics. Keep a
timer only when timeout, deadline, cancellation, or scheduling is the
contract, and control or document that timer. Do not lengthen sleeps or add
arbitrary retries to hide races. Remove mocks, fixtures, helpers, and hooks
when their last meaningful test is removed, and do not leave empty suites.

Do not reimplement production logic in expectations. Prefer a few meaningful
scenarios over exhaustive matrices for tiny helpers or implementation tables.
Committed tests must not depend on live providers. Use
`CLANKY_DISABLE_PASSKEY=true` for unattended tests unless passkey behavior is
the contract being tested. A test using `serveNativeApiRoutes()` does not cover
framework authentication, authorization middleware, CSRF, or same-origin
enforcement; those require the real framework/server boundary. API tests must
not import persistence modules or spy on managers to prove delegation.

Before review, confirm the scenario is not already covered at a higher
boundary, explain any exceptional unit-test rationale, and verify the suite
still discovers at least one meaningful test per bucket. The complete suite
must pass deterministically before the change is considered complete.

Use the test utilities from `tests/setup.ts`:

```typescript
import { setupTestContext, teardownTestContext } from "../setup";

let context: Awaited<ReturnType<typeof setupTestContext>>;

beforeEach(async () => {
  context = await setupTestContext({ initGit: true });
});

afterEach(async () => {
  await teardownTestContext(context);
});
```

### Git Branch Names in Tests

**IMPORTANT:** Never hardcode `main` or `master` as branch names in tests. The default branch name varies between environments (local machines may use `main`, CI may use `master`).

Always get the current branch name dynamically:

```typescript
// WRONG - will fail on systems with different default branch
await Bun.$`git -C ${workDir} push origin main`.quiet();

// CORRECT - works on all systems
const currentBranch = (await Bun.$`git -C ${workDir} branch --show-current`.text()).trim();
await Bun.$`git -C ${workDir} push origin ${currentBranch}`.quiet();
```

### Avoiding Flaky Tests with Polling

**CRITICAL:** Fixed delays are not synchronization. Never use fixed delays
(`delay()`, `setTimeout`) to wait for async operations in tests. Teardown must
await the cleanup it starts; otherwise, poll a named observable condition with
a bounded timeout, short interval, and last-observed-state diagnostics. Never
lengthen a sleep to hide a race. Fixed delays are inherently flaky because
execution time varies across environments.

Instead, use polling helpers that wait for a specific condition to be met:

```typescript
// WRONG - flaky, timing-dependent
await delay(500);
const task = await manager.getTask(taskId);
expect(task.state.status).toBe("completed");

// CORRECT - polls until condition is met
const task = await waitForTaskStatus(manager, taskId, ["completed"]);
expect(task.state.status).toBe("completed");
```

**Available polling helpers in `tests/setup.ts`:**

- `waitForTaskStatus(manager, taskId, expectedStatuses[], timeoutMs?)` - Wait for task to reach status
- `waitForPlanReady(manager, taskId, timeoutMs?)` - Wait for plan's `isPlanReady` to be true
- `waitForFileDeleted(filePath, timeoutMs?)` - Wait for file to be deleted
- `waitForFileExists(filePath, timeoutMs?)` - Wait for file to appear
- `waitForEvent(events, eventType, timeoutMs?)` - Wait for specific event to be emitted

**For HTTP API tests**, use helpers from `tests/integration/user-scenarios/helpers.ts`:

- `waitForTaskStatus(baseUrl, taskId, expectedStatus, timeoutMs?)` - HTTP-based status polling
- `waitForPlanReady(baseUrl, taskId, timeoutMs?)` - HTTP-based plan ready polling

**Guidelines:**

1. Polling helpers should have reasonable timeouts (10s default) with informative error messages
2. Poll interval should be short (50ms) to minimize test duration
3. Error messages should include the last observed state for debugging
4. If you need to wait for a condition, create a new polling helper rather than using `delay()`

## General Guidelines

- Git operations are allowed. The system manages git branches, commits, and merges for Clanky Tasks.
- Always prefer simplicity, usability and top level type safety over cleverness.
- Do not add deprecated aliases or backward-compatibility shims unless the user
  explicitly approves that compatibility requirement.
- Before doing something, check the patterns used in the rest of the codebase.
- Keep the `.clanky-planning/status.md` file updated with progress.
- **Never use time estimates** in plans, documentation, or task descriptions. Time estimates are inherently inaccurate and create false expectations. Use complexity levels (Low, Medium, High) instead.
- **Avoid code duplication**: When you find yourself writing similar code in multiple places, refactor to extract the common logic into a shared function or method. Use parameters to handle variations rather than duplicating code. This improves maintainability and reduces the risk of inconsistent behavior.

## Code Review Learnings — Anti-Patterns to Avoid

These guidelines are distilled from a comprehensive code review (108+ findings). Follow these to avoid repeating past mistakes.

### Data Safety in Persistence

- **Never interpolate variables into SQL** — even for `PRAGMA` queries. Use whitelists or parameterized queries. The `getTableColumns()` function previously interpolated table names directly into SQL strings.
- **Never use `INSERT OR REPLACE`** — it triggers `ON DELETE CASCADE`, silently destroying related rows (e.g., review comments). Always use `INSERT ... ON CONFLICT DO UPDATE` (upsert).
- **Always wrap `JSON.parse` in try/catch** when parsing persisted data. One corrupt row should not prevent loading all records. Use a `safeJsonParse<T>(raw, fallback)` pattern with warning logs.
- **Validate dynamic column names** — if column names come from variables, validate against an allowlist (e.g., `ALLOWED_TASK_COLUMNS`).

### Resource Management

- **Clear timers in `Promise.race`** — when using `setTimeout` as a timeout in `Promise.race`, store the timer ID and call `clearTimeout` in a `.finally()` block.
- **Bound all buffer/array growth** — any array that accumulates data over time (logs, messages, events) must have a maximum size with eviction. Use constants like `MAX_PERSISTED_LOGS` and `slice(-MAX)` eviction.
- **Use `AbortController` for fetch in React hooks** — create an `AbortController` in the effect, pass `signal` to `fetch()`, and call `abort()` in the cleanup function.
- **Cap WebSocket connections** — track active connections and close the oldest when a limit is exceeded.

### Architecture & Layering

- **Respect the layer hierarchy: API → Core → Persistence.** API route modules should contain request validation, authorization, HTTP response mapping, and route-level logging only; they must not import persistence modules or persistence barrels. Route all data access and state changes through Core services/managers (e.g., `TaskManager`, `WorkspaceManager`, or `PreferencesManager`), and keep persistence details behind those Core boundaries.
- **Keep Core services transport-independent.** Core modules own domain validation, orchestration, and cross-repository workflows; they may depend on persistence, but must not depend on API route modules or HTTP response types.
- **Keep persistence focused on storage.** Persistence modules expose database/repository operations and must not import API routes or encode HTTP concerns.
- **Keep cross-boundary types in one canonical tree.** Browser/server-safe domain types and realtime event unions belong in `src/shared/`; public API request/response types and Zod schemas belong in `src/contracts/`. Contracts may depend on shared, but shared must not depend on API routes, persistence, or server-only modules. Keep UI-only and backend-only types beside their owning implementation, and do not recreate compatibility copies or barrels.
- **Centralize state transitions.** Use a state machine with a transition table (`src/core/task-state-machine.ts`) instead of ad-hoc status checks scattered across files. Always call `assertValidTransition()` before changing state.
- **Never mutate state directly in API handlers.** Always delegate state changes to the appropriate Core layer manager method.

### Shared Helpers & Deduplication

Beyond the general "avoid duplication" guideline, watch for these specific recurring patterns:

- **API error/success responses** — use `errorResponse()` and `successResponse()` from `src/api/helpers.ts`. Never create ad-hoc `Response.json({ error: ... })` calls.
- **Workspace lookup + 404** — use `requireWorkspace(workspaceId)` from `src/api/helpers.ts` instead of repeating the lookup-and-check pattern.
- **Frontend API calls** — use the exported action functions from `src/hooks/taskActions.ts` (e.g., `acceptTaskApi`, `pushTaskApi`, `setPendingApi`) instead of writing raw fetch+check+parse boilerplate. These wrap internal helpers (`apiCall`, `apiAction`, `apiActionWithBody`) that are not exported.
- **Shared UI components** — always check if a reusable component exists (e.g., `ModelSelector`, `ConfirmModal`) before building inline equivalents; use the framework notification service for transient feedback.

### Frontend Performance

- **Wrap expensive computations in `useMemo`** — any grouping, sorting, or filtering logic that depends on props/state should be memoized. This applies to task grouping, log entry sorting, and workspace grouping.
- **Use `memo()` for pure display components** — components like `LogViewer` that receive data and render it should be wrapped in `React.memo()`.
- **Prevent double-fetch on mount** — use a ref (`initialLoadDoneRef`) to track whether the initial fetch has completed, preventing duplicate requests from dependency array changes.
- **Avoid loading flicker on event-driven refreshes** — only show loading spinners on initial load, not when refreshing data from WebSocket events.

### Error Visibility

The existing Error Handling section covers try/catch syntax. Additionally:

- **Never leave empty catch blocks** — every catch must either log the error, surface it to the user, or explicitly comment why it's safe to ignore.
- **Use the webapp notification service** (`useToast()` from `@pablozaiden/webapp/web`) to surface transient errors to users. Silent `console.error` is insufficient for user-facing operations.
- **Chain error causes** — when re-throwing or wrapping errors, use `new Error("context message", { cause: originalError })` to preserve the stack trace.
- **Use structured error classes** for domain errors (e.g., `GitCommandError` with command, stderr, exit code fields).
- **Classify domain failures by stable typed codes, not human-readable messages** — use `DomainError` subclasses or discriminated result failures with structured details; treat `message` as presentation text only and preserve the original cause when wrapping.
- **Map typed failures at boundaries** — API and WebSocket handlers must translate known codes to intentional safe responses and use a fixed generic 5xx fallback for unknown failures; browser recovery and retry logic must branch on the public code/status.

### Logging Severity

- **Use `error` for unrecoverable failures** — if the current layer cannot recover and the operation fails, log at `error`.
- **Map request boundary severity by outcome** — at API and WebSocket boundaries, log unexpected server-side failures and 5xx responses at `error`, expected client-side 4xx outcomes at `warn`, and redirects or other non-2xx-but-non-failure outcomes at `info`.
- **Use `warn` for recoverable failures** — log at `warn` when the code falls back, skips optional work, or encounters a non-critical expectation mismatch but can keep going.
- **Use `info` for high-level business milestones** — request start/finish, task lifecycle milestones, provisioning start/finish, and similarly important operation checkpoints belong at `info`.
- **Use `debug` for control-flow detail** — branch decisions, intermediate execution steps, and helper-level flow detail that helps explain how the code moved through an operation should use `debug`.
- **Use `trace` for the most verbose diagnostics** — parameter values, detailed intermediate state, and deep execution detail should use `trace` when that extra detail materially helps diagnosis.
- **Do not duplicate the same failure log across layers** — prefer one clear boundary `error` plus only the lower-level logs that add meaningful new context.
- **Do not log secrets or credential material** — tokens, passwords, auth headers, private keys, raw credential payloads, and similar sensitive values must never appear in `debug` or `trace` logs.

### Component & Method Decomposition

- **Components over 300 LOC should be decomposed.** Extract sub-components (`DashboardHeader`, `TaskGrid`, `DashboardModals`) and custom hooks (`useDashboardData`, `useTaskGrouping`).
- **Large interactive views must separate server lifecycle/realtime state, transcript/display state, and form/composer state.** Effects must be abortable, stale responses must be guarded, and user-facing failures must remain visible. Do not add component tests that lock behavior to the internal decomposition.
- **Methods over 100 LOC should be broken into named sub-methods** with clear single responsibilities (e.g., `buildPrompt()`, `evaluateOutcome()`, `commitIteration()`).
- **Bundle functions with 4+ parameters** into a context/options object (e.g., `TranslateEventContext`).

### Type Hygiene

- **Remove dead types promptly** — unused type aliases, interfaces, and re-exports accumulate fast. If a type is created but never imported, remove it.
- **Single source of truth for shared types** — if the same type (e.g., `ModelInfo`) exists in multiple files, consolidate to one canonical location and import from there.
- **Avoid name collisions** — if two modules export types with the same name but different meanings, rename one to be specific (e.g., `ConnectionStatus` → `WebSocketConnectionStatus`).
- **Keep barrel exports complete and clean** — when adding new modules, add them to the barrel (`index.ts`). When removing modules, clean up their re-exports.

## Common Patterns

### Adding a New API Endpoint

1. Add the route handler in the appropriate `src/api/*.ts` file
2. Export from `src/api/index.ts`
3. Add public request/response types in `src/contracts/api.ts` or the appropriate contract module if needed
4. Add tests in `tests/api/`

### Fixing TypeScript Errors

Common fixes:

1. **Unused imports**: Remove or use them
2. **Unused parameters**: Prefix with `_` (e.g., `_unused`)
3. **Index signature access**: Use `obj["prop"]` instead of `obj.prop` for `Record<string, unknown>` and `process.env`
4. **Type-only imports**: Use `import type { X }` for types not used as values

## Database Migrations

The project uses a migration system to evolve the database schema over time. The complete current schema is defined in `src/persistence/database.ts` as the base schema. Migrations are used only for schema changes added after the base schema was established.

**Note:** The Clanky reset starts from a clean schema baseline in `src/persistence/database.ts`. Historical migrations remain as no-op version markers so clean databases keep the same schema version as already-deployed databases.

### How Migrations Work

1. Migrations are defined in `src/persistence/migrations/index.ts`
2. Each migration has a `version` (sequential integer starting from 1), `name`, and `up` function
3. The `schema_migrations` table tracks which migrations have been applied
4. Migrations run automatically during database initialization
5. Migrations are idempotent - they check if changes already exist before applying

### Adding a New Migration

When you need to add a new column, table, or modify the schema:

1. **Add the migration** to the `migrations` array in `src/persistence/migrations/index.ts`:

```typescript
{
  version: 1, // Next sequential number starting from 1
  name: "add_new_column",
  up: (db) => {
    // Check if column already exists (for idempotency)
    const columns = getTableColumns(db, "tasks");
    if (columns.includes("new_column")) {
      return;
    }
    db.run("ALTER TABLE tasks ADD COLUMN new_column TEXT");
  },
}
```

2. **Do NOT modify the base schema** in `src/persistence/database.ts` for ordinary schema evolution after the Clanky reset. New columns/tables should be added via migrations so existing databases are properly upgraded.

3. **Add a test** in `tests/unit/migrations.test.ts` to verify:
   - The migration applies correctly to databases without the new column
   - The migration is idempotent (doesn't fail if run twice)

### Migration Guidelines

- **Always check if changes already exist** before applying (idempotent)
- **Use sequential version numbers** starting from 1
- **Use descriptive snake_case names** - e.g., `add_user_preferences`
- **Test migrations thoroughly**
- **Verify real upgrade paths, not just happy-path migrations** — future migrations should be tested against the prior Clanky schema version they upgrade from.

### Resetting the Database

If the database gets corrupted or you need a fresh start:

1. **Via UI**: Server Settings modal -> "Reset all settings" button
2. **Via API**: `POST /api/settings/reset-all`
3. **Manual**: Stop Clanky, then delete `clanky.db` and its related WAL/SHM
   files from the configured `CLANKY_DATA_DIR` (default `$HOME/.clanky`) and restart
   Clanky

This will delete all tasks, sessions, and preferences. Use with caution.

<!-- clanky-optimized-v1 -->
## Agentic Workflow — Planning & Progress Tracking

When working on tasks, follow this workflow to ensure clarity, goal alignment, and resilience to context loss:

### Planning

- At the start of any multi-step task, write your goals and plan in `./.clanky-planning/plan.md`.
- Track the status of each task in `./.clanky-planning/status.md`.
- Make sure that goals are written down in a way that you can properly verify them later.
- Don't say something is done until you have verified that all goals are met.
- **Never start implementation before the plan is confirmed.** Present the plan to the user and wait for explicit approval before writing any code. If the plan needs changes, revise and re-confirm before proceeding.

### Incremental Progress Tracking

- After completing each individual task, **immediately** update `./.clanky-planning/status.md` to mark it as completed and note any relevant findings or context.
- Do **not** wait until the end of a session to batch-update progress — update after every task so that progress is preserved even if the session is interrupted or context is lost.

### Pre-Compaction Persistence

- Before ending your response, update `./.clanky-planning/status.md` with:
  - The task you are currently working on and its current state
  - Updated status of all tasks in the plan
  - Any new learnings, discoveries, or important context gathered
  - What the next steps should be when work resumes
- This ensures progress is preserved even if the conversation context is compacted or summarized between iterations. Treat the status file as your persistent memory.

### Goal Verification

- Before considering work complete, check `./.clanky-planning/plan.md` and `./.clanky-planning/status.md` to ensure all tasks are actually marked as completed.
- Follow this general task:
  1. Write down goals in the plan
  2. Implement the work
  3. Verify all goals are met
  4. Update status with progress
  5. If all goals are met, you are done; otherwise, continue from step 2
