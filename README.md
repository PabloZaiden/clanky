# Ralpher

[![Latest Release](https://img.shields.io/github/v/release/pablozaiden/ralpher?style=flat-square&label=Latest%20Release)](https://github.com/pablozaiden/ralpher/releases/latest)
[![Docker Main](https://img.shields.io/github/actions/workflow/status/pablozaiden/ralpher/docker-main.yml?branch=main&style=flat-square&label=Docker%20Main)](https://github.com/pablozaiden/ralpher/actions/workflows/docker-main.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)

Ralpher is a web dashboard and REST API for running, reviewing, and iterating on Ralph Loops with ACP-compatible agents such as Copilot and OpenCode. It keeps autonomous coding work manageable by starting each iteration with fresh context while persisting state in `.planning/`.

**[Download the latest release](https://github.com/pablozaiden/ralpher/releases/latest)**

![Ralpher Dashboard](assets/screenshots/desktop/home.jpg)

*Dashboard overview with active loops, workspaces, and quick actions.*

## Why Ralpher

- **Fresh context, persistent progress.** Ralph Loops use `.planning/plan.md` and `.planning/status.md` to keep long tasks moving across clean agent context windows.
- **Safer automation.** Each loop works in its own branch/worktree, commits iteration-by-iteration, and can be merged or discarded deliberately.
- **Operational visibility.** The dashboard gives you logs, diffs, plan review, loop controls, and follow-up flows in one place.
- **Local or remote execution.** Workspaces can use local `stdio` providers or remote `ssh` transports, with optional SSH sessions and port forwarding.

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

Install the latest binary:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/ralpher/main/install.sh | sh
```

The installer downloads the correct release for Linux or macOS (`x64` or `arm64`) and installs `ralpher` to `~/.local/bin/ralpher`.

You can also download binaries directly from the [Releases page](https://github.com/pablozaiden/ralpher/releases/latest).

## Quick start

### Requirements

- Git
- An ACP-capable CLI in your `PATH` (`opencode` and/or `copilot`)
- Optional SSH access to remote workspace hosts if you plan to use `ssh` transport
- [Bun](https://bun.sh) 1.3.5+ only if you want to run Ralpher from source

### Run Ralpher

```bash
# Installed binary
ralpher

# Development
bun dev
```

The UI is available at `http://localhost:3000` by default. Use `RALPHER_PORT` to change the port and `RALPHER_HOST` to change the bind address.

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
| **Filesystem state** | Progress lives in `.planning/plan.md` and `.planning/status.md`. |
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
| `RALPHER_PASSWORD` | Enables built-in HTTP Basic auth when non-empty | unset |
| `RALPHER_USERNAME` | Username for built-in Basic auth | `ralpher` |
| `RALPHER_DATA_DIR` | Data directory for SQLite persistence | `./data` |
| `RALPHER_REMOTE_ONLY` | Disables local `stdio` transport | unset |
| `RALPHER_MOCK_ACP` | Uses the built-in fake ACP runtime for local testing | unset |
| `RALPHER_LOG_LEVEL` | Server log level override | `info` |

### Auth notes

- Built-in HTTP Basic auth is optional and applies to browser requests, API requests, and WebSocket upgrades.
- Passkey authentication is a separate app-session layer you can enable from **Settings**.
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

The container listens on port `8080` by default. Local/native runs still default to port `3000` unless you override `RALPHER_PORT`.

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

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes with tests when appropriate.
4. Run `bun run build && bun run test`.
5. Open a pull request.

## License

[MIT](LICENSE)
