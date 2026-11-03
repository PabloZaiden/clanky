---
name: webapp
version: 0.6.0
description: 'Build and validate Bun/React apps with @pablozaiden/webapp: storage-free server/client framing, app policy and optional auth bonuses, explicit preferences, UI, realtime, assets, lifecycle and Bun.WebView.'
---

# Webapp framework skill

Maintain this canonical skill in `PabloZaiden/webapp` at
`skills/webapp/SKILL.md`, then synchronize complete downstream copies.
App-specific policy belongs in app guides, never in only one skill copy.

## Read by task

Canonical guides are at the Webapp repository root:

- [Getting started](https://github.com/PabloZaiden/webapp/blob/main/docs/getting-started.md)
  and [server](https://github.com/PabloZaiden/webapp/blob/main/docs/server.md).
- [Optional authentication](https://github.com/PabloZaiden/webapp/blob/main/docs/auth.md)
  and [validation](https://github.com/PabloZaiden/webapp/blob/main/docs/auth-validation.md).
- [Settings/preferences](https://github.com/PabloZaiden/webapp/blob/main/docs/settings.md),
  [sidebar](https://github.com/PabloZaiden/webapp/blob/main/docs/sidebar.md),
  [UI guidelines](https://github.com/PabloZaiden/webapp/blob/main/docs/ui-guidelines.md)
  and [realtime](https://github.com/PabloZaiden/webapp/blob/main/docs/realtime.md).
- [Remote/external clients](https://github.com/PabloZaiden/webapp/blob/main/docs/remote-clients.md),
  [deployment](https://github.com/PabloZaiden/webapp/blob/main/docs/deployment.md),
  [CI](https://github.com/PabloZaiden/webapp/blob/main/docs/github-actions.md)
  and [release](https://github.com/PabloZaiden/webapp/blob/main/docs/release.md).

Consult actual exports/types/callers rather than maintaining a second API
catalog. Use immutable dependency pins with synchronized manifests/lockfiles.

## Ownership and composition

- One Bun process serves React, HTTP and WS. Keep native Bun hot reload; no
  separate frontend server. Apps declare compatible `react` and `react-dom`.
- Core startup does not open SQLite, initialize accounts or read durable
  configuration. Core UI is memory-only without an explicit preference adapter.
- Apps own all identity/account/role/resource policy, auth routes/screens,
  database migrations, credentials, diagnostics and operational actions.
  There is no framework CLI, account store, OAuth/device-auth product or
  mandatory owner/admin model. Do not copy generic framing into apps.
- `createWebAppServer<TEvent,TIdentity>` composes independent identity,
  request, routeMiddleware, realtime admission, custom websocket and lifecycle
  hooks. A minimal public app needs none of the unrelated capabilities.
- `request(req,server?)` returns Response or undefined before generic dispatch
  and document fallback. A successful upgrade consumes the request. Select
  custom WS handlers with `data.webappSocketHandler`; they are not realtime.
- Routes default private and fail closed without an app identity. Explicit
  public intent and realtime `access:"public"` are for deliberately public apps.
  Generic `policy` is opaque app data, not a second framework policy registry.
- Ambient versus explicit credential provenance controls CSRF transport checks,
  never authorization privileges or an assumption of human presence.
- Validate untrusted JSON/headers/CLI/persisted state with runtime schemas.
  `parseJson` accepts a structural safeParse validator and bounds bytes.
  Return intentional 4xx responses; allowlist mutable record fields.
- Preserve request-origin/trusted-proxy, security-header, CSRF, input-limit,
  private-file and lifecycle protections. Public assets/documents are not
  private-data authorization boundaries.
- Generic patterns/catalogs preserve app metadata. Apps publish/authorize any
  catalog themselves. CLI interpretation and delegation remain app-owned.
- Shutdown awaits cleanup/drain hooks with observable failure. Do not install
  competing signal handlers, silently discard cleanup errors or confuse
  immediate termination with graceful stop.

## Optional authentication

Import `/auth` only when explicitly selected. `/auth/browser` exports the
standard WebAuthn browser functions. Bonuses require app-owned persistence,
identity epochs, atomic credential/challenge/session callbacks and attempt
limits. They register no HTTP endpoints or UI by themselves.

Use SimpleWebAuthn/JOSE/Bun Argon2id through bonuses rather than reimplementing
crypto. Password enrollment is for an app-authorized identity; login, change
and browser sessions do not imply public signup, recovery or email. Keep
password login disabled unless an app deliberately enables it.

Consume expiring intended-use challenges atomically. CAS credential counters
and identity epochs so replacement/invalidation fails closed. Keep signing keys
durable/private; implement actual revocation when promising session logout.
Coordinate successful verification with current identity/session epochs.
Apps retaining existing cookies/databases must preserve their external formats
in app-owned adapters, not silently convert/reset them.

## Client runtime and persistence

- Use `appJson`/`appFetch`/`appRequest`, configured request/resource/duplex
  hooks and existing `RealtimeSource` boundaries. No global fetch/WS patches,
  synthetic server account snapshots, extra credential client or plugin loader.
- Generated startup parses neutral bootstrap before the app module.
  `getWebAppClientBootstrap()` reuses it; deployment tags do not activate auth.
  Apps choose saved endpoint, credentials, tickets and connection-picker UI.
- Configure only needed request/connect/resourceUrl/saveResource/runtime hooks.
  Resource hooks receive `kind:"resource"|"websocket"`. Dispose capability/blob
  handles on stale completion, replacement and unmount.
- Runtime supplies stable snapshots `{scope,generation,ready,error?,logLevel,
  logLevelFromEnv?}`. Scope is a cache namespace, not identity authority.
  Advance generation on identity, credential and endpoint changes. Gate private
  runtime until authenticated; retire app-owned caches outside the shared shell.
- Reuse public theme/log-level/runtime hooks. Do not observe root DOM to infer
  theme or independently fetch hidden framework account configuration.
- Select `configureWebAppPreferences({adapter,scope,themeStorageKey})`
  explicitly. Default is memory; `createBrowserPreferenceAdapter` is opt-in.
  Denied browser-storage access reports a warning and falls back to memory.
  Preserve supported `webapp.theme` and client-scoped sidebar/Settings keys.
  Do not invent per-user keys when the app previously used a client namespace.
- Call `initializeWebAppTheme()` after adapter selection, before rendering.
  Document prepaint does not read localStorage. Dark is the no-preference
  default; preserve Light/System.
- Server theme synchronization is app-injected through `WebAppRoot.theme` or
  `ThemeProvider.adapter` load/save callbacks. There is no implicit theme API.
- `WebAppRoot` composes shell/visual Settings, not login/admin/session screens.
  Supply Settings sections/rows or `routes.settings` for app composition.

## UI conventions

- Use `renderWebApp`, shared primitives and shell layouts. Route components use
  top-level `Page`; `layout="full"` handles viewport content. Never duplicate
  the fixed framework title or override internal content geometry.
- Make ordinary actions subtle/unboxed; primary emphasis is explicit.
  Prefer direct actions when space permits, ellipsis for meaningful secondary
  groups/constrained space. Reserve danger emphasis for final confirmation.
- All destructive deletes use `ConfirmDialog` before the mutation. Support
  Escape, X and Cancel, focus and mobile scroll.
- Settings has identity at left and controls/actions right, vertically centered.
  Content-size short inputs; group related fields. Keep feedback inline.
- Use semantic `HeaderPrimaryAction` descriptors and native forms/validation.
  Never click a hidden app submit button to work around shell composition.
- Dialog footers align right, wrap right when needed; never reverse/left-stack
  on mobile. Use shared list/form/tool layouts instead of consumer CSS recipes.
- Keep labels/status/errors concise. Do not show internal operational IDs or
  UUID fallback names unless needed for an actual user task.
- Use framework `useToast` for transient feedback; persistent errors/loading
  belong inline. Do not create another toast queue/provider.
- Preserve native toolbar/header actions and mobile safe-area layout. Use
  `max(spacing, inset)` rather than stacking duplicate bottom clearance.
- Sidebar ready snapshots control pin retirement. Temporary loading/error
  must not delete pins. Async producers/consumers own explicit ready/error state.
- Review desktop/mobile, Dark/Light, narrow actions, scrolling and touch targets.
  Screenshot capture alone is not review.

## Realtime and authoritative state

One shared admitted connection serves dynamic interests, including custom
duplex transports. Apps authorize publications before client-interest filtering;
interests never grant access or choose a storage owner. Recipient keys are
app-selected opaque namespaces.

Use resource invalidations for state collections; versioned streams for
append-only transcript/delta data. Preserve bounded delivery, interest
acknowledgements, reconnection and one authoritative refetch after a gap.
No polling fallback or durable replay subsystem.

`useLiveQuery` loaders return state and honor cancellation. Use its mutation
barrier/reconciliation rather than a second refresh queue; never replay failed
mutations. Obsolete generations cannot commit. Recoverable reconnect/network
interruptions stay silent/status-only, retaining previous data; explicit
operations and terminal protocol failures remain actionable.

## Validation and delivery

Run canonical `bun run typecheck`, `bun run build` and `bun run test`; retain
meaningful public HTTP/WS/process workflows rather than component/layout tests
or regression-only role/route matrices. Use isolated data. Only install
dependencies after a manifest change or an actual missing-dependency failure.

Use disposable `Bun.WebView` for UI flows/captures, not a maintained browser-test
framework. Save artifacts in ignored project directories; do not overwrite
existing captures. Review images against the goal and record actual evidence.

### Browser selection and startup diagnostics

Use Bun 1.4+. On Linux resolve Chromium with `Bun.which("chromium")`; never
hardcode a browser path. Preserve default WebKit on macOS. Report actual browser
startup output before declaring capture blocked. Root-container Chrome may
require explicit `argv:["--no-sandbox"]` in the disposable harness; do not alter
product browser/security settings to accommodate validation.

```ts
const path = process.platform === "linux" ? Bun.which("chromium") : undefined;
if (process.platform === "linux" && !path) throw new Error("Chromium unavailable");
await using view = new Bun.WebView({
  width: 1440, height: 1000,
  ...(path ? { backend: { type: "chrome", path, url: false } } : {}),
});
if (path) {
  await view.navigate("about:blank");
  await view.cdp("Emulation.setEmulatedMedia", {
    features: [{name:"prefers-reduced-motion",value:"reduce"}],
  });
  await view.cdp("Runtime.enable");
}
await view.navigate(appUrl);
await waitFor("document.querySelector('main') !== null");
await settle();
await Bun.write(".cache/captures/desktop.png", await view.screenshot({format:"png"}));
await view.resize(390, 844);
await settle();
await Bun.write(".cache/captures/mobile.png", await view.screenshot({format:"png"}));
```

Implement `waitFor(expression)` with a bounded deadline and animation-frame
progress, not arbitrary sleeps. `navigate` waits for load, not React/API work.
Settle two frames before screenshots. Await each operation: each kind has one
in-flight slot. Chrome CDP is unavailable with WebKit.

Use trusted `view.click`, `type`, `press` and semantic CSS selectors. `type`
inserts text but does not send keydown/keyup; `press` sends shortcuts/submits.
If a control center is obscured, inspect geometry and target its visible child
or coordinates; do not substitute `element.click()`.
Screenshots capture viewport only. Reduced motion avoids paused Chromium view
transitions causing blank captures. Default storage is ephemeral; use an
explicit isolated dataStore only when verifying persistence.

Never publish/deploy/release merely to validate. For authorized Webapp releases
use `bun run release`, confirm bump and proposed target, and follow the guide.
No interim release is needed for coordinated immutable GitHub dependency pins.
