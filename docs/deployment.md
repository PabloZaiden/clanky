# Deployment and configuration

Clanky can run as a local binary, a Docker container, or a controller for
remote execution hosts. This guide covers the settings that matter when the
server is shared or exposed through a reverse proxy.

For a frontend on an ordinary static host with a separate API, see
[Static frontend and remote API](static-client.md). The combined container
remains the default deployment.

## Docker

The image contains the server and web application. Persist `/app/data`:

```yaml
services:
  clanky:
    image: ghcr.io/pablozaiden/clanky:latest
    restart: unless-stopped
    expose:
      - "8080"
    volumes:
      - clanky-data:/app/data
    environment:
      CLANKY_DATA_DIR: /app/data
      CLANKY_PUBLIC_BASE_URL: https://clanky.example.com

volumes:
  clanky-data:
```

For a private local container, publishing the port directly is also enough:

```bash
docker run -d --name clanky --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v clanky-data:/app/data \
  ghcr.io/pablozaiden/clanky:latest
```

The server listens on port `8080` in the image. Keep the data volume
backed up; it contains the application database, credentials, configuration,
and server state.

## Reverse proxy

Use a reverse proxy for any public deployment:

1. Terminate TLS and expose a stable HTTPS origin.
2. Set `CLANKY_PUBLIC_BASE_URL` to that absolute HTTP(S) origin without
   credentials, a path, query, or fragment. Use HTTPS for public deployments.
3. Remove client-supplied forwarded host, protocol, and prefix headers, then
   write sanitized values from the proxy.
4. Forward WebSocket upgrades for `/api/ws` and the raw terminal and preview
   transports.
5. Keep the Clanky listener private to the proxy network or bind it to
   loopback.
6. Persist and back up `/app/data`.

The production image expects a trusted proxy that sanitizes forwarded headers.
Do not expose the container directly to an untrusted network with those
defaults. It enables `CLANKY_TRUST_PROXY=true`, trusts `proto,host,prefix`
headers, and uses the `first` chain policy.

## Configuration

The most common server settings are environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CLANKY_HOST` | Interface used by the server | `127.0.0.1` |
| `CLANKY_PORT` | HTTP port | `3000` |
| `CLANKY_DATA_DIR` | Directory for database, configuration, and logs | `$HOME/.clanky` |
| `CLANKY_PUBLIC_BASE_URL` | External origin used for Mesh, control links and MCP OAuth | unset |
| `CLANKY_MCP_OAUTH_CLIENTS` | JSON array of operator-registered MCP OAuth clients | `[]` |
| `CLANKY_REMOTE_ONLY` | Disable the local execution host | unset |
| `CLANKY_API_ONLY` | Serve API and server-origin authentication/account pages without the app UI | `false` |
| `CLANKY_LOG_LEVEL` | Server log level | `info` |

The Docker image sets its own bind address, port, and data directory. Native
installs keep the local defaults unless you override them.

Application database initialization applies a five-second SQLite busy timeout
before configuring the journal or schema, including worker CLI commands that
overlap server startup. Locks that outlast that budget still fail explicitly.

## Authentication and safety

Passkeys protect browser sessions. Device credentials and API keys are
available for CLI and automation use. Treat API keys, worker keys, and
persisted application data as secrets.

Keep these development-only overrides unset in a public deployment:

- `CLANKY_DISABLE_PASSKEY` bypasses passkey enforcement.
- `CLANKY_DISABLE_SAME_ORIGIN_CHECK` disables origin checks for mutations and
  WebSocket upgrades.

Detached clients use explicit tokens from any hosting origin; no client-host
registration or same-origin override is needed. Cookie-backed browser sessions
retain their same-origin checks. With authentication disabled, even a loopback
API can expose private unauthenticated reads to other websites. Use an isolated
data directory whenever passkey enforcement is disabled.

## Agent control and MCP

Supported native agents and deterministic programs collaborate within their
own project without enabling general Clanky access or installing a CLI/skill.
The workspace's **Allow general
Clanky access** setting additionally permits in-scope cross-project and server
control, within the user's existing permissions. It never grants account,
API-key or session administration. Native tools, Live Voice, external MCP and
deterministic programs share the application-control implementation; they do not
need separate internal MCP servers. See [native control](control-chats.md) and
[Live Voice](voice.md#live-voice) for their client behavior.

ACP model processes do not receive automatic Clanky control or CLI credentials,
even when general access is enabled. Ordinary ACP chats and prompts still work.
Deterministic code keeps its trusted runner control regardless of prompt
adapter, without passing its key to ACP. Legacy nonterminal wildcard
credentials are retired on startup; personal keys and interactive terminal
behavior are unchanged.

External clients connect to **`https://clanky.example.com/mcp`** using Streamable
HTTP. Set a stable `CLANKY_PUBLIC_BASE_URL`, preserve that origin through the
proxy, and keep passkey enforcement enabled. Local development may instead use
a fixed loopback listening port. Do not configure OAuth against an ephemeral
port or change its issuer/resource URL while grants are in use.

### OAuth clients

Register each supported client through `CLANKY_MCP_OAUTH_CLIENTS`, for example:

```json
[
  {
    "clientId": "my-desktop-agent",
    "clientName": "My desktop agent",
    "redirectUris": ["http://127.0.0.1:8181/callback"],
    "grantTypes": ["authorization_code", "refresh_token"]
  }
]
```

Use the client's actual ID and exact callback URI, including its loopback port.
Public callbacks require HTTPS; literal loopback callbacks may use HTTP.
Clients must support operator pre-registration. Dynamic client registration and
automatic client-ID-metadata onboarding are not supported; a client requiring
either cannot use this OAuth configuration unchanged.

The client uses protected-resource/authorization-server discovery, requests the
`clanky:control` scope for the exact `/mcp` resource, and starts an authorization
code flow with S256 PKCE. The user signs in to Clanky and explicitly selects
one owned workspace or general application control on the consent screen.
That choice is validated and persisted by the server, not trusted from a
tool argument or a client-supplied workspace scope.

OAuth access tokens expire after ten minutes. Refresh tokens rotate within a
thirty-day absolute lifetime; narrower refreshes and revocation cannot widen
the original grant. Tokens authenticate only the configured MCP resource,
not Clanky's REST, account, device, key, browser-session or realtime endpoints.
Do not pass browser cookies, unrestricted API keys or credentials in URLs to
an MCP client.

### Unattended service credentials

In **Settings → Agents & integrations**, create a named integration, select its
workspace/general grant and choose an expiry of one to ninety days. Copy the
token when it is first shown and store it privately in the client's credential
configuration. Send it as `Authorization: Bearer <token>` to `/mcp`; never put
it in prompts, source files, command history or query strings. The token is not
shown again. Revoke an unused integration from the same Settings section.

These are limited control credentials, not ordinary unrestricted CLI/API keys.
They cannot approve their own operations, mint keys or obtain a browser session.
Workspace-only integrations cannot inspect other projects, administer the
workspace/access policy or enumerate unrelated servers.

### Human interactions

Destructive and other confirmation-required operations return a frozen,
expiring request and an authenticated Clanky link without performing the
requested mutation. The human reviews and approves or rejects the exact
arguments; scope and target state are checked again before execution.
Approval is single-use. Pending requests do not survive restart or restore
revoked/ended execution authority. A pending result is not completed work,
and an uncertain outcome must be inspected before repeating a mutation.

Missing SSH credentials use a separate private browser handoff. Passwords and
credential tokens do not enter model arguments/results or deterministic code.
Real browser passkey authentication is required for approval, credential
handoff and integration administration. `CLANKY_DISABLE_PASSKEY=true` does
not grant those human capabilities, even on loopback.

## Production access

When inspecting production, use the configured `CLANKY_` environment variables,
such as `CLANKY_BASE_URL` and `CLANKY_API_KEY`, for the actual production API.
Do not substitute local development defaults or print credential values.
Keep passkey and same-origin enforcement enabled.

## Reset persisted data

**Reset all settings** in Server Settings and `POST /api/settings/reset-all`
delete persisted application data and recreate the database. Treat reset as
destructive, not a routine troubleshooting step; preserve a backup if data
must be recoverable. See the [API reference](API.md#post-apisettingsreset-all).

For manual recovery, stop Clanky before removing only `clanky.db` and its
WAL/SHM files from the configured `CLANKY_DATA_DIR`. The default data directory
is `$HOME/.clanky`; never assume the default when a deployment overrides it.

## Remote execution

For workspaces on another machine, pair a trusted Mesh worker or register an
SSH host. Mesh workers provide HTTPS enrollment and controller-to-worker
transport; a relay is useful when workers cannot accept inbound connections.
See the [Mesh worker guide](mesh-worker.md) for setup and trust boundaries.
