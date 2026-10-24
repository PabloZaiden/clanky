# Static frontend and remote API

Clanky supports two deployments from the same source: the normal combined
server/UI binary, and a frontend-only artifact that connects to a remote API.
The static frontend needs no Bun, Node, application server or SPA rewrites.

## Build and publish

```bash
bun install
bun run build
```

The build compiles the frontend once, writes `dist/client/`, and embeds the
same HTML, JavaScript, CSS and assets into `dist/clanky`. The binary does not
need that directory at runtime. To build only the frontend:

```bash
bun run build:client
```

Optionally supply an initial API default at build time:

```bash
CLANKY_CLIENT_API_URL=https://api.example.com bun run build:client
```

Publish **all** of `dist/client/` on an ordinary static HTTP(S) host. The same
directory works at the host root or a nested path, such as `/tools/clanky/`,
without rebuilding asset paths. Open the canonical directory URL with its
trailing slash, or `index.html`. Application navigation uses URL fragments.
The artifact includes icons, its manifest, fonts, browser chunks and Monaco's
editor/language/worker assets; the editor does not require a public CDN.

Replace a deployment atomically rather than mixing files from different builds.
Serve HTML/bootstrap with revalidation; use immutable caching only for
fingerprinted assets. Keep frontend and API on the same Clanky revision during
development. An old production API does not support the new detached-client
authentication contract.

## Configure the API

The combined deployment remains the default:

```bash
clanky serve
```

To serve only the API and API-origin sign-in/account pages:

```bash
clanky serve --api-only
```

`CLANKY_API_ONLY=true` is the equivalent persisted/environment serve option.
API-only mode is independent of execution settings: it does not imply
`CLANKY_REMOTE_ONLY` or turn a controller into a restricted Mesh worker.

Neither API-only nor combined serving requires registering where clients are
hosted. Independently authenticated CLI and browser clients can use the API
from any host. CORS permits non-credentialed browser requests from any origin;
clients provide their API key or device token explicitly instead of relying on
cross-origin cookies. Normal cookie-backed browser mutations retain their
existing same-origin/CSRF checks.

You can omit `--api-only` and serve the integrated UI and independent clients
simultaneously. Authentication, scopes and user ownership determine access,
not the client's hosting URL. Do not disable authentication or same-origin
protection to enable a detached client.

Keep the existing HTTPS/reverse-proxy configuration, including sanitized
forwarded headers, WebSocket forwarding, a stable `CLANKY_PUBLIC_BASE_URL` and
the persistent data volume. A reverse proxy may expose the API under a path
prefix; configure that complete API base URL in the client and forward the
prefix through the existing trusted-proxy configuration.

For an isolated local trial:

```bash
CLANKY_DATA_DIR=/tmp/clanky-static-demo \
clanky serve --api-only

bunx http-server dist/client -a localhost -p 4173
```

Choose the API URL in the static client's connection screen. Plain HTTP is
supported for localhost development only; public API and client origins require
HTTPS. Do not turn off passkeys for a public deployment.

## Connect and sign in

The shared frontend reads `webapp-client.json` before loading the application.
The static file selects remote/token mode and contains the optional public API
default; the unified server supplies integrated/cookie mode and its public path
prefix. No second frontend build is needed. Keep this file in static deployments;
it contains configuration, never credentials.

The client asks for an API URL when no default exists. A local selection takes
precedence over the distributed default. Settings / General / Connection lets
the user change servers or sign out. A failed or unreachable API does not prevent
returning to server selection.

Sign-in follows the CLI's device-authorization flow: open the API's page,
authenticate there with its passkey, verify the code and approve this client.
The frontend polls the token endpoint and receives its own revocable session.
If the browser blocks the new window, use the displayed authorization link.
Passkey management opens the API-origin `/account` page, including in API-only
mode; passkeys are never requested for the static host's origin.

The default browser store keeps access and refresh tokens in localStorage,
namespaced by the exact API and static deployment directory. They are not
encrypted or HttpOnly. Trust the static host as application code: scripts on
that origin, including injected XSS or another application, can read its stored
credentials. Directory namespaces are not a security boundary between scripts
on the same origin. Current browsers with secure-context Web Locks support
coordinate refresh-token rotation across
tabs. API changes reload the client, closing connections and discarding
application caches; private drafts, preferences and SSH credentials are scoped
to the API/client session rather than shared with another server.

HTTP requests use bearer authorization without third-party cookies. Realtime
and raw terminal connections use short-lived, single-use socket tickets.
Protected downloads and video use short-lived target-bound resource tickets;
video previews renew them before expiry for workspace, local and remote
execution targets. Images are fetched with authorization. Long-lived
access/refresh tokens are not put into resource or login URLs. Revoking a device
session removes its API and resource access.

Keep authentication enabled, including on localhost. An API with authentication
disabled can expose private unauthenticated reads to arbitrary websites.
Passkey bypasses are intended only for isolated, disposable validation data.

This frontend can later be packaged in an iPhone WebView without a local
Bun/Node server. The framework exposes native credential-storage and
system-browser login hooks, but native origins, Keychain integration, signing,
packaging and distribution are a separate phase. `file://` hosting, offline
execution/synchronization and a browser-owned Mesh peer are not included.
