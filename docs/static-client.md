# Static frontend and remote API

Clanky supports the normal combined server/UI binary, a static frontend that
connects to a remote API, and a browser-only invited collaboration client.
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

### Continuous GitHub Pages deployments

Every push to `main` publishes both clients together:

| URL | Connection |
| --- | --- |
| https://pablozaiden.github.io/clanky/api/ | Select an HTTPS API and authorize a device session |
| https://pablozaiden.github.io/clanky/collaboration/ | Accept a controller invitation through its HTTPS relay |

The [site root](https://pablozaiden.github.io/clanky/) links both clients and
the deployed commit. Its `build-info.json` records the full source revision and
build timestamp. These deployments follow `main`, not the latest stable release;
compare the deployed commit when investigating browser behavior or API
compatibility. Reload the page after deployment to pick up the new frontend.

The `Publish browser clients` workflow builds PRs without publishing them.
Main pushes and manual runs on `main` deploy through the `github-pages`
environment. Deployments are serialized and superseded revisions are skipped.
Configure repository **Settings > Pages > Source** to
**GitHub Actions** before the first deployment. Both clients are packaged from
one frontend build; only their `webapp-client.json` modes differ. No API URL,
invitation or credentials are preconfigured.

To generate the same complete site locally:

```bash
bun run build:pages
```

Publish all of `dist/pages/`. This command creates a clean site rather than
copying accumulated files from `dist/client/`, and fails if the result exceeds
GitHub Pages' 1 GB site limit. Normal `build`, `build:client` and binary
packaging are unchanged.

Pages is a different origin from localhost or your controller. Authenticate
again for the API client, or create and accept a new invitation for the
collaboration client; existing origin-bound credentials and pairing keys are
not migrated. The two directory paths share the same Pages origin and are not
security isolation boundaries. Trust the public site's code as you would any
other client deployment. Hosting on Pages does not bypass Safari policies or
guarantee a fix for browser-specific connection failures.

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

## Browser-only collaboration

To connect directly to invited controllers through their relays, without an
API server of your own, select the external bootstrap when building:

```bash
CLANKY_CLIENT_MODE=external bun run build:client
```

Publish all of `dist/client/` as above. This uses the same frontend code and
assets as API-backed modes; `webapp-client.json` selects the runtime. Open
**Connect controller** or **Settings > Collaboration**, enter your name and the
invitation, and connect. The controller keeps its normal authorization and
workspace execution responsibilities. The browser is neither a worker nor an
API server and makes no requests to an API on the static host.

The browser and invited Bun controllers use the same pairing, protocol,
request routing, reference qualification, collection composition, realtime and
terminal policy. The relay and Mesh wire generation are unchanged. Multiple
controller connections can coexist; an unavailable controller does not replace
other available sources with an offline copy.

The browser needs a secure context with Ed25519 Web Crypto, IndexedDB and Web
Locks. HTTP localhost is supported; remote relay certificates must be trusted
by the browser. No client-origin registration is needed. Private signing keys
are nonextractable and remain in this site's IndexedDB; reconnect/reload reuses
the saved identity. Only one document may own a pairing at a time. Close the
other tab before reconnecting. Clearing site storage loses the pairing;
controller revocation remains the authoritative way to retire access.
Nonextractable keys do not protect against malicious scripts on the same origin.

Granted workspaces support conversations, tasks/plans, agents, scratchpad,
Git/files, uploads, bounded images and application terminals. New agent
schedules use the selected workspace controller's timezone; editing preserves
the schedule's existing timezone. Quick Chat, templates, Markdown, view/tree
preferences and last-used models are device/profile preferences in this mode.
Controller settings, workspace creation/administration, provisioning and local
execution-host management are not browser capabilities. Arbitrary web/VS Code
previews and inline streamed video require an API-backed client; download video
instead. HTML transcripts are downloaded, not navigated as application-origin
Blob documents.

### Disk downloads and export

Browser-only downloads stream through the relay into origin-private filesystem
storage (OPFS), with an actual-byte limit of **4 GiB per file**
(4,294,967,296 bytes) and at most **64 retained records**. This is not a
whole-response RAM download or an unlimited buffering fallback. Unsupported
disk APIs, quota errors, oversized/truncated responses and cancellations fail
explicitly; incomplete copies are removed, including recovery after an
interrupted document.

Use **Settings > Downloads** to inspect progress, cancel a transfer, export a
completed copy, or remove it with confirmation. **Ready to export** means the
file is in browser storage, not in Downloads or Files. **Export opened** means
the browser download or native share flow started; it does not confirm the
destination saved the file. Verify the exported file before removing the
browser copy. Completed copies survive normal reloads until explicitly removed,
but site-storage clearing or browser eviction can still delete them.

Downloads need OPFS streaming writers and sufficient browser quota and free
disk space. The 4 GiB path has been exercised in Chromium through a real
controller/relay, including an OS-file export; this is **not an iPhone size
guarantee**. Safari/iOS support depends on its version, storage policy, export
support and foreground lifetime. Suspension can interrupt a transfer; there
is no background-download or resumable-transfer guarantee. Image resource URLs
have separate in-memory limits: 20 MiB per image, 60 MiB total and 64 active or
pending resources, and are released by their consumers.

### Portable SDK

`bun run build` also emits `dist/client-sdk/index.js`, a browser ESM entry point
for consumers that need the same invited-client implementation without Clanky's
React UI. Host that directory, including its generated
`dist/client-sdk/collaboration-operations.json`; this catalog is
projected from actual route metadata, not a second hand-written API registry.
`BrowserCollaborationClient.open({ catalogUrl })` loads that catalog and saved
pairings. Its request, session, connection, realtime, duplex, resource and
download APIs own real transports and storage. Call and await `stop()` before
replacing a client. The SDK does not grant access beyond the controller's
existing grants or make browser-specific storage into a server dependency.

This frontend can later be packaged in an iPhone WebView without a local
Bun/Node server. The framework exposes native credential-storage and
system-browser login hooks, but native origins, Keychain integration, signing,
packaging and distribution are a separate phase. `file://` hosting, offline
execution/synchronization and native wrappers are not included.
