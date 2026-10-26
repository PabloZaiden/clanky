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
| `CLANKY_PUBLIC_BASE_URL` | External origin used for Mesh and browser links | unset |
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
