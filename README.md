# Ralpher

[![Latest Release](https://img.shields.io/github/v/release/pablozaiden/ralpher?style=flat-square&label=Latest%20Release)](https://github.com/pablozaiden/ralpher/releases/latest)
[![Docker Main](https://img.shields.io/github/actions/workflow/status/pablozaiden/ralpher/docker-main.yml?branch=main&style=flat-square&label=Docker%20Main)](https://github.com/pablozaiden/ralpher/actions/workflows/docker-main.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)

Ralpher is a web dashboard and REST API for running, reviewing, and iterating on Ralph Loops with ACP-compatible agents such as Copilot and OpenCode. It keeps autonomous coding work manageable by starting each iteration with fresh context while persisting state in `.ralph-planning/`.

The repository is organized as a workspace-style monorepo:

- `apps/server` - Bun server that embeds and serves the web app alongside the API
- `apps/web` - browser bundle workspace for the shared web app assets
- `apps/cli` - standalone API client CLI
- `apps/tui` and `apps/electron` - reserved stubs for future client surfaces
- `packages/shared`, `packages/contracts`, `packages/client-sdk` - shared runtime-neutral types/helpers, API contracts, and client transport/auth utilities

## Best way to use Ralpher

The recommended workflow is to treat Ralpher as a controller for SSH-backed development environments, even when that SSH host is just your own machine.

1. Register an `ssh` server in Ralpher. Using `localhost` is a great default if you want the SSH workflow without needing a separate remote machine.
2. Create an automatic workspace for each project you want to work on, and let that workspace use your devbox-managed environment so tools and dependencies are ready inside the project context.
3. Once the workspace is ready, either open chats to work interactively with the coding agent in that workspace or create a new loop, write the task prompt, and let the agent work autonomously.

**[Download the latest release](https://github.com/pablozaiden/ralpher/releases/latest)**

![Ralpher Dashboard](assets/screenshots/desktop/home.jpg)

*Dashboard overview with active loops, workspaces, and quick actions.*

## Why Ralpher

- **Fresh context, persistent progress.** Ralph Loops use `.ralph-planning/plan.md` and `.ralph-planning/status.md` to keep long tasks moving across clean agent context windows.
- **Safer automation.** Each loop works in its own branch/worktree, commits iteration-by-iteration, and can be merged or discarded deliberately.
- **Operational visibility.** The dashboard gives you logs, diffs, plan review, loop controls, and follow-up flows in one place.
- **Local or remote execution.** Workspaces can use local `stdio` transport or remote `ssh` transports, with optional SSH sessions and port forwarding.

<details>
<summary><strong>More screenshots</strong></summary>

![Create Loop](assets/screenshots/desktop/create-loop.jpg)

*Create a loop with prompt, model, and execution settings.*

![Status View](assets/screenshots/desktop/status.jpg)

*Track iteration status and loop progress in real time.*

![Diff View](assets/screenshots/desktop/diff.jpg)

*Review the accumulated changes before accepting or pushing them.*

![SSH Sessions](assets/screenshots/desktop/ssh.jpg)

*Open persistent SSH sessions alongside loop execution.*
</details>

## Installation

Install the latest binaries:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/ralpher/main/install.sh | sh
```

The installer downloads the correct release assets for Linux or macOS (`x64` or `arm64`) and installs both `ralpher` and `ralpher-cli` to `~/.local/bin/`.

You can also download binaries directly from the [Releases page](https://github.com/pablozaiden/ralpher/releases/latest).

Once installed from a release binary, you can update the CLI client in place:

```bash
ralpher-cli update --check
ralpher-cli update
ralpher-cli update --version v0.8.1
```

`ralpher-cli update` is currently supported for the published Linux and macOS CLI client binaries only. If you are running Ralpher from source with Bun, use the installer script or download release binaries instead of self-updating.

## Quick start

### Requirements

- Git
- An ACP-capable CLI in your `PATH` (`opencode` and/or `copilot`)
- Optional SSH access to remote workspace hosts if you plan to use `ssh` transport
- [Bun](https://bun.sh) 1.3.5+ only if you want to run Ralpher from source

### Run Ralpher

```bash
# Installed server binary (embedded API + web, same-origin)
ralpher

# Source development (combined API + web, same-origin)
bun dev

# Server process only
bun run dev:server
```

The UI is available at `http://localhost:3000` by default. Use `RALPHER_PORT` to change the port and `RALPHER_HOST` to change the bind address.

The normal development and published runtime is same-origin: the Bun server hosts the React app and the API together, and the frontend defaults to relative `/api` requests.
In development, `bun dev` watches the shared web bundle in `apps/web/dist` and serves that processed output from the server so Tailwind/CSS behaves the same way as the bundled app.

### CLI client commands

The separately installed `ralpher-cli` binary exposes the terminal client surface:

```bash
# Check which version is installed
ralpher-cli version

# Check whether a newer published binary is available
ralpher-cli update --check

# Update the installed release binary in place
ralpher-cli update

# Install a specific published release
ralpher-cli update --version v0.8.1

# Start device authorization against a specific Ralpher server
ralpher-cli auth http://localhost:3000

# Check whether stored CLI credentials are still valid
ralpher-cli status

# List the discoverable REST endpoints
ralpher-cli api

# Invoke an authenticated API request (prints one JSON object)
ralpher-cli api loops/my-loop --method GET

# Inspect the expected schema for an endpoint
ralpher-cli schema auth/device

# Stream authenticated websocket events over stdio
ralpher-cli ws --loop-id my-loop
```

`ralpher-cli version` prints the installed client version, and the built-in help output shows the same version banner for quick support/debugging context. `ralpher-cli update --check` compares the installed version with the latest published GitHub Release, `ralpher-cli update` replaces the current installed client binary in place, and `ralpher-cli update --version <tag>` installs a specific published CLI release. `ralpher-cli auth` stores the chosen server URL alongside the tokens under the user's home folder (`~/.ralpher/cli-auth.json` by default), so later `ralpher-cli status`, `ralpher-cli api`, and `ralpher-cli ws` requests reuse that same server automatically. `ralpher-cli status` and `ralpher-cli ws` both accept an optional positional base URL override if you need a different target server. When `ralpher-cli api <endpoint>` calls an endpoint, it prints a single parseable JSON object with the HTTP status metadata under `status` and the parsed body, plain-text body, or `null` under `response`.

`ralpher-cli ws` connects to `/api/ws` with the stored bearer token and cookies, then bridges websocket text frames to stdout and stdin lines back to the websocket. Use one JSON value per non-empty stdin line and keep stderr reserved for diagnostics. Supported filters mirror the server query parameters: `--loop-id`, `--chat-id`, `--ssh-session-id`, `--ssh-server-session-id`, and `--provisioning-job-id`.

### Create your first loop

1. Open the dashboard and click **New Loop**.
2. Pick or create a workspace that points at your repository.
3. Choose the provider and transport for that workspace.
4. Write the task prompt, select the model, and create the loop.
5. Review plans, logs, diffs, and final changes from the loop details view.

## How a Ralph Loop works

A Ralph Loop is an external execution loop around an AI coding agent. Instead of keeping all history inside one growing chat, each iteration starts fresh and reads the project state from the filesystem.

| Principle | Description |
| --- | --- |
| **Fresh context per iteration** | Every iteration starts with a clean agent context window. |
| **Filesystem state** | Progress lives in `.ralph-planning/plan.md` and `.ralph-planning/status.md`. |
| **Stop condition** | The loop ends when the configured completion pattern is produced. |
| **Git isolation** | Changes stay isolated in a branch/worktree until you accept, push, or discard them. |

## Key features

- **Dashboard + API:** manage loops from the browser or automate them through the REST API.
- **Plan mode:** review and refine a generated plan before code changes begin.
- **Review cycles:** continue from completed, pushed, or merged work with follow-up prompts and review comments.
- **Live observability:** stream logs, inspect diffs, and track loop state over WebSocket updates.
- **Workspace flexibility:** configure provider and transport per workspace, including remote SSH-backed execution.
- **Testing support:** use `RALPHER_MOCK_ACP=true` to replace local provider launches with the built-in mock ACP runtime.

## Configuration and deployment

### Common environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `RALPHER_HOST` | Host/interface passed to `Bun.serve` | `127.0.0.1` |
| `RALPHER_PORT` | HTTP port | `3000` |
| `RALPHER_DATA_DIR` | Data directory for SQLite persistence | `./data` |
| `RALPHER_REMOTE_ONLY` | Disables local `stdio` transport | unset |
| `RALPHER_MOCK_ACP` | Uses the built-in fake ACP runtime for local testing | unset |
| `RALPHER_DISABLE_PASSKEY` | Bypasses passkey enforcement when set to `true`, `1`, or `yes` | unset |
| `RALPHER_DISABLE_SAME_ORIGIN_CHECK` | Disables `Origin`/`Referer` validation for state-changing requests and WebSocket upgrades | unset |
| `RALPHER_LOG_LEVEL` | Server log level override | `info` |

### Auth notes

- Same-origin protection is enabled by default for mutating API requests and WebSocket upgrades by requiring `Origin` or `Referer` to match the effective request origin.
- Passkey authentication protects the browser session and device-approval flow.
- Bearer tokens are issued through the device authorization flow and work as an alternative to the browser passkey session for APIs, WebSocket upgrades, and forwarded-port proxy access.
- `ralpher-cli auth` stores bearer credentials in per-user CLI state under the home directory, `ralpher-cli status` validates them through `GET /api/auth/status`, `ralpher-cli api` sends authenticated REST calls with the stored tokens, `ralpher-cli ws` uses those same credentials for authenticated websocket upgrades to `/api/ws`, and `ralpher-cli schema` exposes endpoint discoverability data from the built-in API catalog.
- Ralpher exposes `/.well-known/openid-configuration` and `/.well-known/jwks.json` so external clients can verify access tokens.
- Set `RALPHER_DISABLE_PASSKEY=true`, `1`, or `yes` to bypass only the passkey requirement as an emergency override.
- Set `RALPHER_DISABLE_SAME_ORIGIN_CHECK=true`, `1`, or `yes` only for development setups where the frontend intentionally runs on a different local origin than the backend. Leave it unset in normal and production deployments.
- In production, Ralpher is typically deployed behind a reverse proxy that handles authentication and authorization.

### Docker

```yaml
services:
  ralpher:
    image: ghcr.io/pablozaiden/ralpher:latest
    ports:
      - "8080:8080"
    volumes:
      - ralpher-data:/app/data
    environment:
      RALPHER_DATA_DIR: /app/data

volumes:
  ralpher-data:
```

The container listens on port `8080` by default and starts the same embedded server product that the `ralpher` binary runs locally. Docker overrides the bind host to `0.0.0.0`; local/native runs default to `127.0.0.1` unless you override `RALPHER_HOST`.

## Documentation

- [API reference](docs/API.md)
- [Project conventions and agent workflow](AGENTS.md)

## Development

```bash
git clone https://github.com/pablozaiden/ralpher.git
cd ralpher
bun install
bun run build
bun run test
bun dev
```

`bun run build` creates a standalone executable in `dist/ralpher`.
It also builds `apps/server/dist/ralpher` and `apps/cli/dist/ralpher-cli`.

To repopulate local demo data for the UI, run:

```bash
bun tests/test-data-generation/generate-demo-ui-data.ts
```

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes with tests when appropriate.
4. Run `bun run build && bun run test`.
5. Open a pull request.

## License

[MIT](LICENSE)
