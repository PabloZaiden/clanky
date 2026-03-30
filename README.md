# Ralpher

[![Latest Release](https://img.shields.io/github/v/release/pablozaiden/ralpher?style=flat-square&label=Latest%20Release)](https://github.com/pablozaiden/ralpher/releases/latest)
[![Docker Main](https://img.shields.io/github/actions/workflow/status/pablozaiden/ralpher/docker-main.yml?branch=main&style=flat-square&label=Docker%20Main)](https://github.com/pablozaiden/ralpher/actions/workflows/docker-main.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)

**A web dashboard for managing Ralph Loops** - an autonomous AI development pattern that solves context accumulation in AI coding assistants by using fresh context windows with filesystem-based state persistence.

**[Download Latest Release](https://github.com/pablozaiden/ralpher/releases/latest)**

---

![Ralpher Dashboard](assets/screenshots/desktop/home.jpg)

*Dashboard overview with active loops, workspaces, and quick actions*

<details>
<summary><strong>More Screenshots</strong></summary>

### Desktop

![Home View](assets/screenshots/desktop/home.jpg)

*Dashboard overview with active loops, workspaces, and quick actions*

---

![Create Loop](assets/screenshots/desktop/create-loop.jpg)

*Create a new loop with prompt, model, and execution settings*

---

![Status View](assets/screenshots/desktop/status.jpg)

*Loop status overview with iteration progress*

---

![Logs View](assets/screenshots/desktop/logs.jpg)

*Real-time log streaming as the AI works*

---

![Diff View](assets/screenshots/desktop/diff.jpg)

*Side-by-side diff of all changes made*

---

![Plan View](assets/screenshots/desktop/plan.jpg)

*View the planning documents*

---

![Actions View (Pre-Loop)](assets/screenshots/desktop/actions-pre-loop.jpg)

*Configure and review loop actions before starting execution*

---

![Actions View](assets/screenshots/desktop/actions.jpg)

*Loop actions: stop, accept, push, delete*

---

![SSH Sessions](assets/screenshots/desktop/ssh.jpg)

*Open persistent SSH sessions alongside loop execution*
</details>

---

## What is a Ralph Loop?

A Ralph Loop is an autonomous AI development pattern that uses an external loop to repeatedly feed prompts to an AI agent. The agent works on a task until a specific completion condition is met. Each iteration starts with a fresh context window, relying on the filesystem (via `.planning/` documents) for state persistence.

| Principle | Description |
|-----------|-------------|
| **Fresh Context per Iteration** | Each iteration starts with a clean context window |
| **State Persistence** | Progress tracked via `.planning/plan.md` and `.planning/status.md` in target project |
| **Stop Condition** | Loop terminates when AI output ends with `<promise>COMPLETE</promise>` |
| **Git Safety** | Work isolated in branch, committed per iteration, merged on acceptance |

---

## Installation

**Install the latest release** (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/ralpher/main/install.sh | sh
```

This downloads the appropriate binary for your platform (Linux/macOS, x64/arm64) and installs it to `~/.local/bin/ralpher`.

> **Note:** You can also download binaries directly from the [Releases page](https://github.com/pablozaiden/ralpher/releases/latest).

---

## Features

- **Web Dashboard** - Real-time monitoring of multiple concurrent loops
- **REST API** - Full control over loop lifecycle
- **Git Integration** - Automatic branch per loop, commit per iteration, merge on accept
- **Real-time Updates** - Live log streaming via WebSocket
- **Model Selection** - Choose AI models from available providers
- **Plan Mode** - Review, refine, and accept plans before autonomous execution starts
- **Feedback Cycles** - Restart finished loops from the bottom composer, including review follow-ups on pushed or merged loops
- **SSH Sessions** - Open persistent dtach-backed terminal sessions for SSH workspaces
- **Port Forwarding** - Expose remote loop services through browser-safe local proxy routes
- **Workspace-Scoped Settings** - Configure provider and transport per workspace
- **AGENTS.md Optimization** - Preview and apply Ralpher-specific AGENTS.md guidance

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3.5+ (for development only)
- Git
- An ACP-capable CLI in your PATH (`opencode` and/or `copilot`)
- Optional SSH access to remote workspace hosts (for `ssh` transport)

### Running Ralpher

```bash
# Using the installed binary
ralpher

# Or run directly with Bun (development)
bun dev
```

The web UI will be available at `http://localhost:3000` (configurable via `RALPHER_PORT`).

When the server starts, it logs the effective listening address and whether built-in basic auth is enabled so you can verify the current exposure immediately.

### Creating Your First Loop

1. Click **"New Loop"** in the dashboard
2. Select a workspace (or create one with the project directory path)
3. Write your task prompt (the PRD/requirements)
4. Generate or enter a loop name, then select a model and configure the loop settings
5. Click **"Create"** - the loop starts automatically unless you save it as a draft first

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RALPHER_HOST` | Host/interface passed to `Bun.serve` (e.g. `0.0.0.0` to listen on all interfaces, or a specific IP to bind to a particular network interface) | `127.0.0.1` |
| `RALPHER_PORT` | Server port | `3000` |
| `RALPHER_PASSWORD` | Enable built-in HTTP Basic auth for every request when this is non-empty after trimming | unset |
| `RALPHER_USERNAME` | Username for built-in HTTP Basic auth when `RALPHER_PASSWORD` enables it | `ralpher` |
| `RALPHER_DATA_DIR` | Data directory for persistence | `./data` |
| `RALPHER_REMOTE_ONLY` | Disable local `stdio` transport and only allow `ssh` transport (`true`/`1`/`yes`) | unset |
| `RALPHER_MOCK_ACP` | Replace local ACP CLI launches with Ralpher's built-in fake ACP runtime for testing (`true`/`1`/`yes`) | unset |
| `RALPHER_LOG_LEVEL` | Override server log level (`silly`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`) | `info` |

### Optional Built-In Basic Auth

Set `RALPHER_PASSWORD` to a non-empty value to require HTTP Basic auth on every request, including API requests, websocket upgrades, and the SPA fallback. The username defaults to `ralpher`; set `RALPHER_USERNAME` if you want a different username.

```bash
RALPHER_PASSWORD=secret ralpher
RALPHER_USERNAME=admin RALPHER_PASSWORD=secret ralpher
RALPHER_HOST=127.0.0.1 RALPHER_PASSWORD=secret ralpher
```

Startup logs explain both the effective bind address and whether auth is enabled or disabled. They also mention `RALPHER_HOST`, `RALPHER_PASSWORD`, and `RALPHER_USERNAME` so it is clear which env vars to change.

### Data Storage

Ralpher stores all data in a SQLite database:

```
data/
├── ralpher.db       # SQLite database (loops, sessions, preferences)
├── ralpher.db-shm   # SQLite shared memory (runtime)
└── ralpher.db-wal   # SQLite write-ahead log (runtime)
```

### Mock ACP Runtime for Testing

Set `RALPHER_MOCK_ACP=true` to make local `stdio` workspaces use Ralpher's built-in fake ACP server instead of launching `opencode` or `copilot`.

```bash
RALPHER_MOCK_ACP=true ralpher
```

This mode is intended for testing and end-to-end automation. The mock runtime speaks ACP over stdio, streams delayed agent-like text, supports session lifecycle flows, and exercises protocol surfaces such as config updates, tool calls, permissions, questions, file-system requests, terminal requests, and cancellation handling.

---

## Usage Guide

<details>
<summary><strong>Monitoring a Loop</strong></summary>

1. Click on a loop card to view details
2. Watch real-time logs as the AI works
3. Use the **"Prompt"** tab to modify the next iteration's prompt
4. Use the **"Diff"** tab to see changes made so far

</details>

<details>
<summary><strong>Accepting Changes</strong></summary>

When a loop completes (or you stop it manually):

1. Review the diff tab to see all changes
2. Click **"Accept (Merge)"** to merge the branch into the original
3. Or delete the loop to discard changes

</details>

<details>
<summary><strong>Addressing Reviewer Comments</strong></summary>

After accepting or pushing a loop, you can iteratively improve the work based on reviewer feedback.

#### For Pushed Loops

1. Complete a loop and click **"Push"** to push the branch to the remote
2. Loop status becomes "Pushed" with an "Addressable" badge
3. After code review, click **"Address Comments"** button
4. Enter reviewer feedback in the modal
5. The loop restarts on the same branch to address the comments
6. Push again after completion - cycle repeats as needed

#### For Merged Loops

1. Complete a loop and click **"Accept (Merge)"** to merge into main/base branch
2. Loop status becomes "Merged" with an "Addressable" badge  
3. After reviewing the merged changes, click **"Address Comments"**
4. Enter feedback about what needs improvement
5. The loop creates a new review branch (`<branch-prefix><name>-review-<N>`)
6. Work is done on the review branch, then merged back to main
7. Merge again after completion - cycle repeats as needed

You can also use the bottom composer directly on addressable pushed or merged loops to send a generic follow-up message without opening the reviewer-comments modal. Ralpher reuses the same branch strategy as review comments: pushed loops continue on the pushed branch, and merged loops create a fresh review branch.

#### Review History

The **"Review"** tab shows:
- Comment history with status badges (Pending/Addressed)
- Number of review cycles completed
- List of review branches created

</details>

<details>
<summary><strong>Restarting a Finished Loop</strong></summary>

When a loop reaches a restartable terminal state, the bottom composer becomes a restart surface instead of a mid-run queue.

- `completed`, `stopped`, `failed`, and `max_iterations` restart as a new feedback cycle on the same logical loop
- `pushed` and `merged` accept generic follow-up messages from the same composer, reusing review-cycle branch handling
- `deleted` loops can be revived before purge, reusing preserved branch/worktree state when available

</details>

<details>
<summary><strong>Modifying In-Flight</strong></summary>

While a loop is running:

- Use the **"Prompt"** tab to set a "pending prompt" for the next iteration
- The current iteration continues with its original prompt
- The next iteration will use your updated prompt

</details>

<details>
<summary><strong>Using Plan Mode</strong></summary>

- **Plan mode** lets you review the generated `.planning/plan.md` before the loop starts editing code
- Plans can be refined with feedback, accepted to start the loop, or handed off directly to an SSH session

</details>

<details>
<summary><strong>SSH Sessions and Port Forwarding</strong></summary>

- SSH workspaces can open persistent dtach-backed terminal sessions from the loop details view
- Loop-linked port forwards expose remote services through browser-safe proxy URLs such as `/loop/<loopId>/port/<forwardId>/`
- Port forwards support HTTP and WebSocket traffic and are tracked per loop

</details>

---

## API Reference

See [docs/API.md](docs/API.md) for complete API documentation.

---

## Technology Stack

| Category | Technology |
|----------|------------|
| Runtime | [Bun](https://bun.sh) 1.3.5+ |
| Language | TypeScript (strict mode) |
| Frontend | React 19 |
| Styling | Tailwind CSS v4 |
| AI Integration | ACP-compatible agent CLIs (Copilot/OpenCode) |
| Real-time | WebSocket |

---

## ACP Runtime Architecture

Ralpher separates agent interaction from deterministic repository operations:

| Channel | Purpose | Runtime |
|---------|---------|---------|
| **Agent Channel** | AI sessions, prompts, streaming, tool events, permissions | ACP JSON-RPC via provider CLI (`opencode acp` or `copilot --yolo --acp`), or the built-in mock runtime when `RALPHER_MOCK_ACP=true` |
| **Execution Channel** | Git/file/command operations used by loop orchestration and APIs | `CommandExecutor` (local for `stdio`, remote over SSH for `ssh`) |

This decoupling allows Ralpher to support multiple ACP providers while keeping repository operations deterministic and transport-aware.

---

## Development

### Setup

```bash
git clone https://github.com/pablozaiden/ralpher.git
cd ralpher
bun install
bun dev
```

### Building

```bash
# Build standalone executable
bun run build

# Run the executable
./dist/ralpher
```

The build creates a single standalone executable that includes the Bun runtime and all dependencies.

### Cross-compilation

```bash
bun run build --target=bun-linux-x64
bun run build --target=bun-linux-arm64
bun run build --target=bun-darwin-x64
bun run build --target=bun-darwin-arm64
```

### Testing

```bash
bun run test           # Run all tests
bun run tsc            # Type check
```

### Code Style

See [AGENTS.md](AGENTS.md) for detailed coding guidelines.

---

## Workspace Connection Transports

Ralpher uses provider + transport settings per workspace:

| Transport | Description |
|-----------|-------------|
| **stdio** | Ralpher starts the configured ACP CLI locally (`opencode acp` or `copilot --yolo --acp`), or the built-in mock ACP runtime when `RALPHER_MOCK_ACP=true` |
| **ssh** | Ralpher starts the configured ACP CLI on a remote host via SSH |

> **Tip:** If you want headless isolated environments for Ralpher, [Devbox](https://github.com/pablozaiden/devbox) is a great fit. You can run repositories and ACP tooling inside a Devbox environment and connect to it from Ralpher over `ssh`, keeping loop execution cleanly separated from your main machine.

### Per-Workspace Server Configuration

Each workspace has its own server configuration, allowing you to:

- **Run multiple workspaces in parallel** with different server settings
- **Connect to different remote servers** for different projects
- **Mix local and remote transports** across your workspaces

To configure server settings for a workspace:

1. Click the **gear icon** next to a workspace name in the dashboard header
2. Select provider (**OpenCode** or **Copilot**) and transport (**stdio** or **ssh**)
3. For `ssh`, enter hostname, port, and optional username/password or identity file
4. Click **Test Connection** to verify the settings
5. Click **Save Changes** to apply

Changes take effect immediately - the workspace connection will be reset to use the new settings.

---

## Docker

```yaml
services:
  ralpher:
    image: ghcr.io/pablozaiden/ralpher:latest
    ports:
      - "8080:8080"
    volumes:
      - ralpher-data:/app/data
    environment:
      - RALPHER_DATA_DIR=/app/data

volumes:
  ralpher-data:
```

The container image listens on port `8080` by default because it runs as a non-root user. Local/native runs still default to `3000` unless you override `RALPHER_PORT`.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Run `bun run build && bun run test`
5. Submit a pull request

---

## License

[MIT](LICENSE)
