# Clanky

[![Latest Release](https://img.shields.io/github/v/release/pablozaiden/clanky?style=flat-square&label=Latest%20Release)](https://github.com/pablozaiden/clanky/releases/latest)
[![Main Publication](https://img.shields.io/github/actions/workflow/status/pablozaiden/clanky/binary-release.yml?branch=main&style=flat-square&label=Main%20Publication)](https://github.com/pablozaiden/clanky/actions/workflows/binary-release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1?style=flat-square&logo=bun)](https://bun.sh)

Clanky is a coding-agent manager for running, reviewing, and iterating on
software tasks with Codex, Copilot, OpenCode, Claude Code, Pi, and Grok Build.
It combines a web dashboard, an authenticated CLI, isolated workspaces, live
conversation visibility, planning, and iteration in one application.

**Promo**

https://github.com/user-attachments/assets/25427c86-2b8b-41c0-a77f-4aad427dee93

**Hands-on tutorial (2 minutes)**

Local setup, three OpenCode chats, Code Explorer, and live Preview.

https://github.com/user-attachments/assets/c5245a2d-0a66-4632-b437-a502e8629726

## Why Clanky

- **Visible changes:** work in isolated branches or worktrees and inspect
  their diff from the conversation.
- **One control plane:** manage chats, plans, automations, workspaces, terminals,
  files, and previews from the dashboard or API.
- **Local or remote execution:** run locally or use a remote Mesh host
  when the repository and agent should live elsewhere.

![Clanky dashboard](assets/screenshots/desktop/home-promo.png)

*Active work, scheduled automations, workspaces, and execution hosts in one place.*

<details>
<summary><strong>More screenshots</strong></summary>

![Chat with an agent](assets/screenshots/desktop/chat-promo.png)

*Discuss the requirements, iterate on a plan, and implement in one conversation.*
</details>

<details>
<summary><strong>Mobile screenshots</strong></summary>

![Clanky dashboard on mobile](assets/screenshots/mobile/home-promo.png)
</details>

## Install

Install the latest Linux or macOS binary:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/clanky
```

Or download a binary from the [latest release](https://github.com/pablozaiden/clanky/releases/latest).
The installer verifies the release checksum and places `clanky` in
`$HOME/.local/bin`.

## Quick start

### Requirements

- Git
- An installed native Copilot, Codex or OpenCode 2 runtime, or an ACP-capable
  integration, with its required authentication; see [harness adapters](docs/harnesses.md)
- [Bun](https://bun.sh) only when running Clanky from source

### Start the server

```bash
# Installed binary
clanky serve

# From a source checkout
bun install
bun dev
```

Open <http://localhost:3000>. Use `CLANKY_PORT` or `CLANKY_HOST` to change the
default port or bind address.

### Use the CLI

```bash
clanky auth --base-url http://localhost:3000
clanky status
clanky api
clanky api chats --method GET
clanky schema chats
clanky ws
```

See the [getting started guide](docs/getting-started.md) for the first
workspace and chat, and the [API reference](docs/API.md) for the complete CLI
and HTTP contract.

### Run with Docker

```bash
docker run -d --name clanky --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v clanky-data:/app/data \
  ghcr.io/pablozaiden/clanky:latest
```

For a public deployment, keep port `8080` behind a reverse proxy and follow
the [deployment guide](docs/deployment.md).

## Remote execution

Clanky works well as a controller for repositories running on a remote host.
Use the [Mesh worker guide](docs/mesh-worker.md) for automatic workspaces,
worker enrollment, relay connections, and remote execution. The
[deployment guide](docs/deployment.md) covers HTTPS, reverse proxies, and
Docker persistence.

## Documentation

The [documentation index](docs/README.md) organizes the guides by task:

- [Getting started](docs/getting-started.md)
- [Deployment and configuration](docs/deployment.md)
- [Mesh workers and relays](docs/mesh-worker.md)
- [API reference](docs/API.md)
- [Development](docs/development.md)

## License

[MIT](LICENSE)
