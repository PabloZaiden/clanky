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
Clanky access** setting permits all normal catalogued JSON operations within
the user's existing permissions, including cross-project work, Git, scheduled
agents, terminals, previews, maintenance, Mesh administration and framework
diagnostics. There is no separate list of enabled control modules. Operations
declare their read/write/confirmation policy or an explicit exclusion at their
canonical route definition. General access does not make the user an admin or
owner and does not bypass confirmations.

Exclusions cover account/key/session and control-grant administration, private
credentials and invitation/enrollment/trust material, approving one's own
actions or changing approval policy, client-provenance acknowledgements,
internal protocols and browser-owned binary/media/streaming flows. Public
configuration/status projections without secrets remain readable, including
Voice settings and relay status. Native tools, Live Voice, external MCP and
deterministic programs share the application-control implementation; they do not
need separate internal MCP servers or CLI credentials. The controller admits
internal authority from the active execution source; native Mesh tools reuse
the authenticated lease's event/RPC infrastructure without a return endpoint.
See [native control](control-chats.md) and
[Live Voice](voice.md#live-voice) for their client behavior.

For an intent not covered by a direct tool, use `clanky_list_operations` with
`{}` once instead of guessing search keywords. It returns the complete authorized
index without schemas or pagination: `columns` identifies the `operationId`,
`policy` and abbreviated `description` in each `operations` row, and `total`
counts all rows. Then use `clanky_describe_operation` for the chosen operation's
exact inputs and `clanky_execute_operation` to invoke it. Filtered, paged search
remains available when needed. The index follows the same current authority as
description/execution; it cannot broaden a workspace grant. A catalog that
cannot fit reports an explicit error, never a partial index.

General control can read `GET /api/health` to obtain the connected instance's
health and running application version, plus public framework configuration and
authorized operational settings. This diagnoses the instance owning the control
connection, not an arbitrary production URL or the browser's loaded frontend
version. Account/authentication protocols are not part of this operational catalog.

ACP model processes do not receive automatic Clanky control or CLI credentials,
even when general access is enabled. Ordinary ACP chats and prompts still work.
Deterministic code keeps its controller-owned control regardless of prompt
adapter, without granting that authority to ACP. Old automatic nonterminal
credentials are retired on startup; external integrations, personal keys and
interactive terminal behavior are unchanged. Upgrade the controller and worker
for lease-owned native control as described in
[Mesh rollout](mesh-worker.md#execution-owned-control-tools); persisted pairing
does not need to be recreated.

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

In **Settings → Agents & integrations → Approvals**, each user controls
**Require approval for agent operations**. It is enabled by default for both
existing and new users. Only a genuine passkey-authenticated human can change
it; native agents, MCP clients and deterministic code cannot disable it.

When enabled, destructive and other confirmation-class control operations
return a frozen, expiring request and an authenticated Clanky link without
performing the requested mutation. The human reviews the exact arguments;
scope and target state are checked again before execution. When disabled,
new nonvoice operations execute directly within their existing permissions.
This does not expand grants, approve existing pending requests, configure
providers' own terminal/file permissions.
Changes apply to new operations immediately, without restarting chats.
**Live Voice always requires visual confirmation**, regardless of this setting.

The pending list is in the same **Approvals** Settings section, with individual
links also available in Home's **Needs attention**. Each action is reviewed
separately.
Native, MCP and deterministic confirmations expire one hour after creation.
Reading a request does not extend its deadline, and reviewing one does not
consume another. Live Voice confirmations keep their
existing one-minute deadlines.
Approval is single-use. Pending requests do not survive restart or restore
revoked/ended execution authority. A pending result is not completed work,
and an uncertain outcome must be inspected before repeating a mutation.

Real browser passkey authentication is required for approval, approval-policy
changes, credential handoff and integration administration. `CLANKY_DISABLE_PASSKEY=true` does
not grant those human capabilities, even on loopback.

## Reset persisted data

**Reset all settings** in Server Settings and `POST /api/settings/reset-all`
delete persisted application data and recreate the database. Treat reset as
destructive, not a routine troubleshooting step; preserve a backup if data
must be recoverable. See the [API reference](API.md#post-apisettingsreset-all).

For manual recovery, stop Clanky before removing only `clanky.db` and its
WAL/SHM files from the configured `CLANKY_DATA_DIR`. The default data directory
is `$HOME/.clanky`; never assume the default when a deployment overrides it.

## Remote execution

For workspaces on another machine, pair a trusted Mesh worker.
Mesh workers provide HTTPS enrollment and controller-to-worker
transport; a relay is useful when workers cannot accept inbound connections.
See the [Mesh worker guide](mesh-worker.md) for setup and trust boundaries.
