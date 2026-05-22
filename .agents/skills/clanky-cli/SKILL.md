---
name: clanky-cli
description: Use this skill when you need to inspect or operate a Clanky server from a terminal with clanky-cli, including installing the CLI, checking authentication, discovering endpoints and schemas, calling common APIs, and streaming websocket events.
compatibility: Requires shell access, network access to the target Clanky server, and curl/sh if clanky-cli is not already installed.
---

# Operate Clanky through `clanky-cli`

Use this skill when the task should be completed through the terminal client instead of the web UI or direct raw HTTP calls.

See [the reference guide](references/REFERENCE.md) for command examples, endpoint families, and websocket usage details.

## Preferred execution flow

### 1. Confirm `clanky-cli` is installed

Check whether the command is already available:

```bash
command -v clanky-cli >/dev/null 2>&1 && clanky-cli version
```

If it is missing, install it with the published one-liner from the README:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/clanky/main/install.sh | sh
```

That installer places both `clanky` and `clanky-cli` in `~/.local/bin/`.

### 2. Check whether the CLI is already authenticated

Use:

```bash
clanky-cli status
```

You can optionally pass a base URL override when you need to target a different server:

```bash
clanky-cli status http://localhost:3000
```

Interpret the result before doing anything else:

- `Logged in to ...` means the stored credentials are ready to use.
- `Not logged in.` means the CLI has no usable credentials yet.
- `Stored credentials are invalid.` means the saved credentials can no longer be refreshed and you must authenticate again.

### 3. Authenticate when needed

If `status` shows that the CLI is not authenticated, run:

```bash
clanky-cli auth <base-url>
```

This starts the device flow. The CLI prints:

- an `Open:` URL
- a short `Code:`
- `Waiting for approval...`

Guide the user to open the URL and approve the device request. Wait for the CLI to report `Authenticated with <base-url>`.

### 4. Discover before mutating

Do not guess endpoints or payload shapes.

Start with:

```bash
clanky-cli api
```

This lists the discoverable REST endpoints. Then inspect the exact request or query schema for the endpoint you plan to call:

```bash
clanky-cli schema <endpoint>
```

Examples:

```bash
clanky-cli schema tasks
clanky-cli schema tasks/my-task/pending
clanky-cli schema workspaces/my-workspace/files/write
```

The CLI normalizes endpoint paths, so `tasks`, `/tasks`, `api/tasks`, and `/api/tasks` all resolve to the same catalog entry.

### 5. Call APIs through the CLI

Use:

```bash
clanky-cli api <endpoint> [--method <method>] [--payload '<json>']
```

Notes:

- `GET` is the default method.
- `--payload` must be valid JSON.
- Output is a single JSON object with `status` metadata and the parsed `response`.
- Read endpoints first when exploring a server state.
- For `POST`, `PUT`, or `PATCH`, inspect the schema immediately before sending the request.

### 6. Use websocket streaming for live events

Use:

```bash
clanky-cli ws [base-url] [--task-id <id>] [--chat-id <id>] [--ssh-session-id <id>] [--ssh-server-session-id <id>] [--provisioning-job-id <id>]
```

Important websocket rules:

- The command reuses the same stored credentials as `status` and `api`.
- Prefer filters so you only receive relevant events.
- When writing to stdin, send one valid JSON value per non-empty line.

## Guardrails

- Prefer `clanky-cli` over hand-written `curl` requests once the CLI is available.
- Use `clanky-cli api` and `clanky-cli schema` as the source of truth for endpoint discovery.
- Avoid destructive endpoints unless the task explicitly requires them.
- Re-run `clanky-cli status` when auth-related requests fail unexpectedly.
- Keep the task grounded in the currently discoverable API catalog instead of assuming undocumented endpoints.
