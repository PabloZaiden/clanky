---
name: webapp
description: 'Build, modify, validate, and ship apps using @pablozaiden/webapp. Use when creating framework apps, adding routes, auth, settings, realtime, sidebar actions, Docker, GitHub Actions, screenshots, or Playwright validation.'
---

# Webapp framework skill

Use this skill when building an app with `@pablozaiden/webapp`.

## Rules

- Treat the app as one Bun server that serves React, API routes and websockets together.
- Do not add Vite or a standalone client dev server.
- Use `bun --hot src/index.ts serve` for dev.
- Keep the product as one app and one binary with subcommands (`serve`, `version`, app-specific commands, and optional framework-backed `auth`/`api`/`schema` commands). Do not split web/server/CLI into separate apps or binaries unless there is a real package boundary.
- Keep generated apps and tooling cross-platform across macOS and Linux on arm64 and x86-64.
- Use Playwright for all browser automation and screenshots; do not hard-code Chrome, browser executable paths, or OS-specific browser automation.
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
- Route components rendered inside `WebAppRoot.routes` must use `Page` as the top-level main-content wrapper. Do not render raw panels/lists directly into `WebAppRoot`, and do not use or recreate `wapp-main-content`; `Page` provides the standard content margins/padding on desktop and mobile.
- Set `sidebar.search: false` when the app has a small fixed navigation tree and should not show the framework sidebar search box.
- For entity actions, define one `ActionMenuItem[]` builder and attach it to the route-backed `SidebarNode.actions`; the framework reuses those actions for sidebar right-click and the active route title-bar three-line menu. Use `WebAppRoot.header.getActions` only for extra route-level actions not owned by an active sidebar node.
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

## Minimum server shape

```ts
import appleTouchIconPath from "./apple-touch-icon.png" with { type: "file" };
import faviconPath from "./favicon.svg" with { type: "file" };
import manifestIcon192Path from "./web-app-manifest-192x192.png" with { type: "file" };
import manifestIcon512Path from "./web-app-manifest-512x512.png" with { type: "file" };
import { createWebAppServer, defineRoutes } from "@pablozaiden/webapp/server";

const app = createWebAppServer({
  appName: "Example",
  envPrefix: "EXAMPLE",
  web: {
    icons: {
      favicon: { src: faviconPath, sizes: "any", type: "image/svg+xml" },
      appleTouch: { src: appleTouchIconPath, sizes: "180x180", type: "image/png" },
      manifest: [
        { src: manifestIcon192Path, sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: manifestIcon512Path, sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    },
  },
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  routes: defineRoutes({}),
});

await app.runFromCli();
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

Run targeted tests, `bun run tsc`, example binary builds, app health checks, and `bun run screenshots`. Use `docs/auth-validation.md` for manual passkey/API-key/device-auth validation. If Docker base images can be pulled, build and run the example containers and check `/api/health`.

## CI/CD checklist for generated apps

Use `docs/github-actions.md` as the source of truth. At minimum, generated apps should include:

- A root `Dockerfile` that builds with `oven/bun`, copies the standalone binary into a slim runtime image, runs as a non-root user, and healthchecks `/api/health`.
- `.github/workflows/pr.yml` with install, build, test, Bun dev-server smoke checks, and Docker image smoke checks.
- `.github/workflows/docker-main.yml` to publish `ghcr.io/<owner>/<repo>:main` after merges to `main` and smoke-test the container.
- `.github/workflows/binary-release.yml` using `pablozaiden/installer/.github/workflows/reusable-binary-release.yml`.
- `.github/workflows/docker-release.yml` to publish semver GHCR images on published GitHub releases.

Replace `my-app` and `MY_APP` with the app binary name and `envPrefix`. Keep CI-only auth escape hatches such as `MY_APP_DISABLE_PASSKEY=true` out of production runtime defaults.
