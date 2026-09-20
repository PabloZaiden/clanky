# Getting started

This guide takes you from an installed Clanky binary to a first task.

## Requirements

- Git
- An ACP-capable provider runtime:
  `copilot`, `opencode`, `grok`, `claude-agent-acp`, `pi-acp`, or `codex-acp`
- Bun when running Clanky from source

If the selected provider command is not installed, Clanky can use the provider
package through `npx` or `bunx` when that provider supports it. Codex also
requires an authenticated `codex` CLI.

## Start Clanky

Use the installed binary:

```bash
clanky serve
```

Or run the combined server and web application from a source checkout:

```bash
bun install
bun dev
```

Open <http://localhost:3000>. The default bind address is `127.0.0.1` and the
default port is `3000`. Set `CLANKY_HOST` or `CLANKY_PORT` when the server
needs a different interface or port.

For a detached local server, use:

```bash
clanky serve up
clanky serve status
clanky serve down
```

## Authenticate the CLI

The browser uses passkey-backed authentication. The CLI can use the device
authorization flow:

```bash
clanky auth --base-url http://localhost:3000
clanky status
```

After authentication, discover and call endpoints with:

```bash
clanky api
clanky schema tasks
clanky api tasks --method GET
clanky ws
```

For unattended scripts, set `CLANKY_BASE_URL` and `CLANKY_API_KEY` instead of
storing credentials in a CLI profile. Keep the key out of shell history and
logs.

## Create a workspace

1. Open **Servers** and select an execution host. A local host is the simplest
   option; SSH and Mesh hosts run repository operations on another machine.
2. Create a workspace and select its repository, host, and provider.
3. Wait for the workspace to become ready.
4. Open a chat for interactive work, or create a task for an autonomous run.

Automatic Devbox workspaces use a dedicated Mesh worker by default. If you
need a remote host, a worker, or a relay, start with the
[Mesh worker guide](mesh-worker.md).

## Run and review a task

Write the task prompt and choose the provider and model. Plan mode lets you
review a generated plan before code changes begin. During and after execution
you can inspect logs, the diff, and the task state.

When the result is ready:

- accept it locally when you want to keep the worktree without pushing;
- push it when the branch is ready for review;
- discard it when the changes should not be kept.

Completed or accepted work can receive follow-up prompts and review comments.
The dashboard exposes these actions from the task view.

## Common next steps

- [Deploy Clanky with Docker or a reverse proxy](deployment.md)
- [Configure a Mesh worker or relay](mesh-worker.md)
- [Automate tasks and workspaces](API.md)
- [Run and test Clanky from source](development.md)
