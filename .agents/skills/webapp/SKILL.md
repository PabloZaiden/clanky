---
name: webapp
version: 0.5.10
description: 'Build, modify, validate, and ship apps using @pablozaiden/webapp. Use when creating framework apps, adding routes, auth, settings, realtime, sidebar actions, Docker, GitHub Actions, screenshots, Bun.WebView validation, or explaining how to inspect applications that use webapp with Bun.WebView.'
---

# Webapp framework skill

Use this skill when building an app with `@pablozaiden/webapp`.

## Repository-local references

The expanded templates and manual checklist referenced below are maintained in
the `pablozaiden/webapp` repository at its repository root, not relative to
this skill file or an installed skill bundle:

- [`docs/github-actions.md`](https://github.com/PabloZaiden/webapp/blob/main/docs/github-actions.md)
  contains the full Docker and GitHub Actions templates.
- [`docs/auth-validation.md`](https://github.com/PabloZaiden/webapp/blob/main/docs/auth-validation.md)
  contains the manual passkey, API-key, and device-auth checklist.

Paths such as `.github/workflows/pr.yml` in this document are files to create in
the application being built; they are not expected to exist beside this skill.

## Rules

- Treat the app as one Bun server that serves React, API routes and websockets together.
- Do not add Vite or a standalone client dev server.
- Use `bun --hot src/index.ts serve` for dev.
- Do not create app-owned `index.html` or `site.webmanifest`; the framework generates the HTML document, PWA manifest, default SVG icons, fixed-scale viewport metadata and theme prepaint script from `createWebAppServer({ web })`.
- The generated viewport uses fixed-scale tokens. On iPhone/iPad and other mobile browsers that honor those tokens, it prevents pinch-to-zoom while preserving scrolling; clients that ignore them are unaffected. Do not add global touch handlers, `preventDefault()` calls, or `touch-action: none` to solve zoom.
- PWA is enabled by default. Lightweight examples may use generated initials icons, but production apps should set `web.icons` with favicon, Apple-touch, and 192x192/512x512 manifest PNGs. Icon paths are relative to the app package root.
- Keep the product as one app and one binary with subcommands (`serve`, `version`, app-specific commands, and optional framework-backed `auth`/`api`/`schema` commands). Do not split web/server/CLI into separate apps or binaries unless there is a real package boundary.
- Keep generated apps and tooling cross-platform across macOS and Linux on arm64 and x86-64.
- Use `Bun.WebView` from Bun 1.4+ for browser automation and screenshots; do not add external browser automation packages or launch a browser directly from an application.
- When screenshots are captured to validate a visual change, review them against the specific goal; capture alone is not validation.
- Configure env through a single uppercase `envPrefix`; read framework env as `{PREFIX}_...`.
- Prefer the framework shell, settings and auth conventions when in doubt.
- Frontend entrypoints should use `renderWebApp(<App />)` from `@pablozaiden/webapp/web`, not `ReactDOMClient.createRoot(...)`, so hot reload reuses the existing React root.
- Treat apps as multi-user by default. App data should include an owner/current-user id unless the route is deliberately public or global-admin.
- In server routes prefer declarative `auth: "user"`, `auth: "admin"` or `auth: "owner"` and use `ctx.requireUser()`, `ctx.requireAdmin()`, `ctx.requireOwner()`, `ctx.assertUser(userId)`, `ctx.filterOwned(records)` and `ctx.requireOwned(record)` instead of ad-hoc auth checks.
- Add route metadata (`description`, `cliPath`, `tags`, schemas) directly to `defineRoutes` entries when an app needs CLI API discovery; use `createRouteCatalog` instead of maintaining a separate API catalog.
- Make public endpoints explicit with `auth: "public", sameOrigin: "never"`.
- Do not disable same-origin except for deliberate non-browser routes.
- Use scopes for API keys and device bearer tokens.
- Keep settings framework-owned; add app-specific settings as custom sections with `scope: "user"`, `"admin"` or `"owner"`.
- Use `WebAppRoot`, `SidebarNode` and framework UI primitives before custom shell/layout code.
- Use `useToast()` from `@pablozaiden/webapp/web` for transient success, error, warning, and informational feedback. Do not add an app-owned toast provider, queue, timer system, or notification styling; use inline `ErrorState`, loading states, and validation for persistent page/form state.
- Route components rendered inside `WebAppRoot.routes` must use `Page` as the top-level main-content wrapper. Do not render raw panels/lists directly into `WebAppRoot`, and do not use or recreate `wapp-main-content`; `Page` provides the standard content margins/padding on desktop and mobile by default. Use `<Page layout="full">` for viewport-sized child content that owns its own spacing or scrolling instead of overriding framework CSS.
- Set `sidebar.search: false` when the app has a small fixed navigation tree and should not show the framework sidebar search box.
- Use `sidebar.tabs` for fixed bottom sidebar selectors; `getNodes` receives the selected `activeTab` alongside `search`. Tab ids persist per app, omitted icons use the title initial, and `icon: null` creates a text-only tab.
- When sidebar data is asynchronous, return `getNodes` snapshots as `{ nodes, ready }`; keep `ready: false` during loading, refresh, or error so native pinning cannot reconcile against a partial tree.
- For entity actions, define one `ActionMenuItem[]` builder and attach it to the route-backed `SidebarNode.actions`; the framework reuses those actions for sidebar right-click and the active route title-bar overflow menu. Use `WebAppRoot.header.getActions` only for extra route-level actions not owned by an active sidebar node.
- When a main-content view has multiple available actions, put them in framework-owned shell actions rather than app-local header/menu implementations. Keep discrete buttons for form submission and truly primary inline controls.
- Mark route-backed sidebar entities with `pinnable: true` instead of building app-owned Pinned sections; the framework injects Pin/Unpin and persists pins in localStorage.
- Sidebar badges are compact colored dots; use `badge`/`badgeVariant` for status without relying on visible sidebar badge text.
- Do not reimplement framework dialogs/modals. Framework dialogs handle Enter as confirm/primary action and Escape as cancel/close.
- Mark destructive menu items with `destructive: true`; delete-labelled actions are treated defensively, rendered red, and ordered last by the framework.
- Do not add app-local shell/header action menus for active entities. If the action belongs to a task/chat/agent/session/workspace/server sidebar entity, put it on that node's `actions`.
- Framework header actions and icon/sidebar buttons must remain visible and non-deforming; let titles/subtitles truncate instead of clipping actions.
- For user-owned live updates, prefer `ctx.userRealtime.publishEntityChanged(resource, id)` / `publishChanged(resource)` and `useRealtimeRefresh({ resources, refresh })` over custom websocket wiring. Use global `ctx.realtime` only for public/global-admin events or server-validated non-user scopes.
- Use app-owned websocket upgrade handlers only for raw transports such as terminals, VNC or port-forward proxies; keep normal app state on framework realtime.
- Prefer `Page`, `Panel`, `DataList`, `DataListRow`, `DangerZone`, `LoadingState`, `ErrorState`, `FormGroup`, `FormActions`, and `CodeValue` for main content before custom CSS. Use `EntityHeader` only when the content needs an entity-specific heading that is not already provided by the fixed framework title bar.
- Prefer structured `settings.sections[].rows` for settings; keep `render` only as an escape hatch.
- All destructive delete actions must show a framework `ConfirmDialog` before the mutation. Never wire Delete buttons directly to `DELETE` requests.
- Server lifecycle actions such as kill/reboot must show confirmation first and then a 15-second shutdown countdown progress bar after a successful response.
- Test user-visible functionality and behavior, not implementation details such as internal class names, DOM structure or component internals.
- When creating a production-ready app, add the Dockerfile and GitHub Actions from `docs/github-actions.md`: PR build/test/dev-smoke/Docker-smoke, main GHCR Docker image, binary release, and Docker release.

## Server state and lifecycle

- The framework owns the application state directory. It defaults to
  `$HOME/.<app-directory-name>`, deriving the name from `envPrefix` when
  `appDirectoryName` is omitted (`MY_APP` becomes `.my-app`).
- `{PREFIX}_DATA_DIR` replaces the default state directory completely. Keep
  framework SQLite data, `config.json`, detached-server metadata, and
  `logs/server.log` under that resolved directory; do not add an app-local
  `./data` fallback when using `createWebAppServer`.
- Use the built-in lifecycle commands without aliases:
  `serve` for foreground operation, `serve up` for a detached server,
  `serve down` for idempotent shutdown, `serve status` for inspection, and
  `serve config show|set|unset` for persisted bootstrap settings.
- `config.json` stores only validated bootstrap values: `server.host`,
  `server.port`, and `development.sourcePath`. Environment variables override
  persisted host and port values; `serve up/down/status --host/--port` are
  one-shot overrides.
- `serve up --dev` never accepts a source path argument. It requires
  `development.sourcePath` to be configured and existing, invokes the
  application-provided build adapter before stopping the current server, and
  then launches the generated binary without a `--dev` flag. A failed build
  must leave the current server running.
- Applications provide only their development build and generated command;
  do not put an application's `dist` layout or bespoke process-manager script
  into the framework. The detached parent must not construct the app or open
  its database before spawning the child.
- Lifecycle process ownership checks must refuse to stop an unrecognized
  process that occupies the configured port. Keep PID/log writes atomic and
  use the framework's state-directory and locking helpers.

The canonical lifecycle API is documented in
[`docs/cli.md`](https://github.com/PabloZaiden/webapp/blob/main/docs/cli.md).

## Headless browser validation with Bun.WebView

This workflow is for the coding agent when validating an application that depends on
`@pablozaiden/webapp`, not for the application itself. Bun 1.4+ and a compatible
browser are required; this workflow intentionally has no fallback. Do not add
`Bun.WebView`, browser binaries, external browser automation packages, browser
scripts, or browser configuration to the application. `Bun.WebView` is an
experimental Bun API, so keep the harness small and disposable.

On Linux, use Chromium (or another Chrome-family browser) available through
`PATH`. The repository devcontainer installs the Chrome for Testing headless
shell and exposes it as `chromium`, so no executable path should be hard-coded.
On macOS, the default backend is the system `WKWebView`; this is not Safari and
does not require a browser download. The Chrome backend is available on macOS
too, but the WebKit backend is the default there.

Start the application with its normal Bun server and use the URL it announces.
Prefer `localhost` over assuming `127.0.0.1`, because a server may listen only
on IPv6. For authenticated flows, `{PREFIX}_DISABLE_PASSKEY=true` is allowed
only with disposable local data. Never use production data or disable same-origin
checks for browser validation.

Create the harness outside the application repository. Use Bun directly; do not
install a package just to drive the browser:

```bash
webview_workdir="$(mktemp -d)"
trap 'rm -rf "$webview_workdir"' EXIT
export APP_URL="http://localhost:<port>"
export WEBVIEW_OUT_DIR="$webview_workdir/screenshots"
mkdir -p "$WEBVIEW_OUT_DIR"

bun - <<'EOF'
const appUrl = process.env.APP_URL;
const outputDir = process.env.WEBVIEW_OUT_DIR;
if (!appUrl || !outputDir) {
  throw new Error("APP_URL and WEBVIEW_OUT_DIR are required");
}

const useChrome = process.platform !== "darwin";
const chromeArgs =
  process.env.WEBAPP_WEBVIEW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
const backend = useChrome
  ? { type: "chrome", url: false, argv: chromeArgs }
  : "webkit";

await using view = new Bun.WebView({
  backend,
  headless: true,
  console: globalThis.console,
  dataStore: "ephemeral",
  width: 1440,
  height: 920,
});

view.onNavigationFailed = (error) => {
  console.error(`[webview] navigation failed: ${error.message}`);
};

if (useChrome) {
  // A first navigation establishes the CDP session. Configure reduced motion
  // before loading the app so native route transitions cannot pause headless
  // screenshots.
  await view.navigate("about:blank");
  await view.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  view.addEventListener("Runtime.exceptionThrown", (event) => {
    console.error("[webview] page exception", event.data);
  });
  await view.cdp("Runtime.enable");
}

await view.navigate(appUrl);

const waitFor = async (expression, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await view.evaluate(expression)) {
      return;
    }
    await view.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))",
    );
  }
  throw new Error(`Timed out waiting for: ${expression}`);
};

const settle = () =>
  view.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );

await waitFor("document.readyState === 'complete'");
await waitFor("document.querySelector('main') !== null");
await settle();
await Bun.write(`${outputDir}/desktop.png`, await view.screenshot({ format: "png" }));

// Replace these selectors with stable controls exposed by the application.
await view.click('button[aria-label="Open menu"]');
await waitFor("document.querySelector('[role=dialog]') !== null");
await settle();
await Bun.write(`${outputDir}/menu.png`, await view.screenshot({ format: "png" }));

await view.resize(390, 844);
await settle();
await Bun.write(`${outputDir}/mobile.png`, await view.screenshot({ format: "png" }));
EOF
```

`await using` closes the view even when the harness throws. The default storage
is ephemeral; use `dataStore: { directory: "..." }` only when the flow must
verify persistence, and keep that directory temporary. With Chrome, a
persistent directory belongs to the entire Chrome process, not an individual
view. `url: false` forces a fresh Chrome process instead of attaching to an
existing browser.

`navigate()` waits for the main frame's `load` event, not for React or API work
that happens afterward. `click(selector)` waits for the selector to become
actionable, but follow it with a page-state wait when the click triggers
asynchronous rendering. Poll with `requestAnimationFrame` as above; do not use
arbitrary sleeps. `evaluate()` accepts an expression and awaits promises; wrap
multiple statements in an IIFE. Await every operation on one view because each
operation kind has one in-flight slot.

`Bun.WebView` does not provide high-level role/label locators or a portable
accessibility snapshot. Inspect the DOM with `evaluate()` and use stable,
user-facing CSS selectors such as
`button[aria-label="..."]`, semantic elements, or application-owned test
attributes. `click()` dispatches native trusted input. `type()` inserts text
into the focused control but does not send `keydown`/`keyup`; use `press()` for
keyboard shortcuts and submit keys. `screenshot()` captures the viewport only,
so resize or scroll before each capture when those states matter.

Known webapp/Chromium quirks:

- Configure `prefers-reduced-motion: reduce` through
  `Emulation.setEmulatedMedia` before the app navigation. Without it,
  `document.startViewTransition` can remain paused in headless Chromium: the
  route content exists in the DOM while screenshots are blank or fail.
- Wait two animation frames before taking a screenshot after navigation,
  resize, or a route/state change.
- The click target must be the topmost element at its center. If a framework
  button container times out because its center resolves to an ancestor or
  overlay, target its visible child instead (for example,
  `button.wapp-sidebar-item strong`) or click coordinates obtained from its
  bounding rectangle. Do not replace native `click()` with
  `element.click()`; that would not exercise trusted browser input.
- The Chrome backend supports raw CDP through `view.cdp()`; the WebKit backend
  does not. Do not use CDP setup when the selected backend is `webkit`.
- Chromium in a container may need `--no-sandbox`. Set
  `WEBAPP_WEBVIEW_NO_SANDBOX=1` only in that isolated environment; the
  repository devcontainer sets it for its local Chromium. Keep it unset on a
  normal Linux host and never use the flag for untrusted pages outside the
  isolated validation environment.

Review every screenshot against the requested visual behavior; capturing a file
without inspecting it is not validation. Keep screenshots, browser profiles,
and harness files in temporary or git-ignored locations. Do not overwrite
checked-in reference captures unless the task explicitly asks for an update.

## Minimum server shape

```ts
import { createWebAppCli } from "@pablozaiden/webapp/cli";
import { createRouteCatalog, createWebAppServer, defineRoutes } from "@pablozaiden/webapp/server";

const routes = defineRoutes({});
let app: ReturnType<typeof createWebAppServer> | undefined;
const getApp = () => app ??= createWebAppServer({
  appName: "Example",
  envPrefix: "EXAMPLE",
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  routes,
});

const cli = createWebAppCli({
  appName: "Example",
  commandName: "example",
  envPrefix: "EXAMPLE",
  version: "1.0.0",
  routeCatalog: createRouteCatalog(routes),
  start: async () => {
    await getApp().start();
  },
});

process.exitCode = await cli.run();
```

## Minimum UI shape

```tsx
import { Page, Panel, WebAppRoot, renderWebApp } from "@pablozaiden/webapp/web";

function Home() {
  return (
    <Page>
      <Panel>Hello</Panel>
    </Page>
  );
}

renderWebApp(
  <WebAppRoot
    appName="Example"
    homeRoute={{ view: "home" }}
    sidebar={{ getNodes: () => [{ type: "section", id: "main", title: "Main", children: [] }] }}
    routes={{ home: <Home /> }}
  />,
);
```

Always import framework styles explicitly from the frontend entrypoint:

```ts
import "@pablozaiden/webapp/web/styles.css";
```

Use the framework-owned action menu for entity actions:

```tsx
const actions = buildProjectActions(project);

const node = { type: "item", id: project.id, title: project.name, route: { view: "project", projectId: project.id }, actions, pinnable: true };
```

Use the declarative realtime helpers:

```ts
ctx.userRealtime.publishEntityChanged("todos", todo.id);
```

```tsx
useRealtimeRefresh({ resources: ["todos"], refresh });
```

Use structured settings rows:

```tsx
settings={{
  sections: [{
    id: "sync",
    title: "Sync",
    scope: "user",
    rows: [{ id: "status", title: "Status", description: "Connected" }],
  }],
}}
```

Use user-owned routes:

```ts
GET: (_req, ctx) => {
  return jsonResponse(ctx.filterOwned(items));
}

PATCH: (_req, ctx) => {
  const item = ctx.requireOwned(items.find((candidate) => candidate.id === ctx.params.id));
  return jsonResponse(item);
}
```

## Validation checklist

Run targeted tests, `bun run typecheck`, example binary builds, and app health checks. Use the temporary Bun.WebView harness above for visual validation, and use `docs/auth-validation.md` for manual passkey/API-key/device-auth validation. If Docker base images can be pulled, build and run the example containers and check `/api/health`.

## CI/CD checklist for generated apps

Use `docs/github-actions.md` as the source of truth. At minimum, generated apps should include:

- A root `Dockerfile` that builds with `oven/bun`, copies the standalone binary into a slim runtime image, runs as a non-root user, and healthchecks `/api/health`.
- `.github/workflows/pr.yml` with install, build, test, Bun dev-server smoke checks, and Docker image smoke checks.
- `.github/workflows/docker-main.yml` to publish `ghcr.io/<owner>/<repo>:main` on pushes to `main` and smoke-test the container.
- `.github/workflows/binary-release.yml` using `pablozaiden/installer/.github/workflows/reusable-binary-release.yml`.
- `.github/workflows/docker-release.yml` to publish semver GHCR images on published GitHub releases.

Replace `my-app` and `MY_APP` with the app binary name and `envPrefix`. Keep CI-only auth escape hatches such as `MY_APP_DISABLE_PASSKEY=true` out of production runtime defaults.
