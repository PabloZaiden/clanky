---
name: clanky
description: Use the Clanky CLI to inspect and operate an existing authenticated Clanky instance. Activate when a user wants to query Clanky state, discover available Clanky API endpoints, create or monitor tasks, interact with chats or agents, stream events, or automate Clanky through the `clanky` command without starting or installing Clanky.
compatibility: Requires `clanky` on PATH, existing CLI authentication, and network access to the target Clanky instance.
---

# Clanky CLI usage for agents

Use this skill when you need to operate an existing Clanky instance from a terminal through the `clanky` CLI. Assume Clanky is already installed, configured, authenticated, and reachable. Do not install Clanky, start a server, or guide the user through authentication unless the user explicitly asks for that.

Clanky evolves over time, so prefer discovery over memorized command details. Treat the running CLI and its API/schema output as the source of truth.

## Core workflow

1. Confirm the CLI is available and see the supported command surface:

   ```bash
   clanky help
   clanky version
   clanky status
   ```

2. Discover available API endpoints:

   ```bash
   clanky api
   ```

3. Inspect the request/response shape for the endpoint you plan to call:

   ```bash
   clanky schema tasks
   clanky schema workspaces
   ```

4. Call the API using endpoint paths relative to `/api`:

   ```bash
   clanky api workspaces --method GET
   clanky api tasks --method GET
   clanky api tasks/my-task-id --method GET
   ```

5. Stream live events when you need progress updates:

   ```bash
   clanky ws
   ```

## Important CLI conventions

- Use `clanky help` for CLI help. Do not assume every subcommand accepts `--help`.
- `clanky api` with no endpoint lists discoverable API endpoints.
- `clanky api <endpoint>` calls authenticated REST endpoints and prints one JSON object.
- Endpoint paths are relative to `/api`; use `tasks`, not `/api/tasks`.
- Use `--method <METHOD>` for non-default methods.
- Use `--payload '<json>'` for request bodies.
- Use `clanky schema <endpoint>` before constructing payloads, especially for task, workspace, chat, or agent-related endpoints.
- Use `clanky auth --base-url URL` to configure a profile for a server. Framework commands use the selected profile or the `CLANKY_BASE_URL`/`CLANKY_API_KEY` environment pair.

## Running commands and downloading files

Discover workspaces first and use the dedicated workspace commands for
operations on their execution host:

```bash
clanky api workspaces --method GET | jq .

clanky workspace exec <WORKSPACE_ID_OR_EXACT_NAME> -- git status --short
clanky workspace exec <WORKSPACE_ID_OR_EXACT_NAME> --cwd /tmp -- sh -lc 'printf "hello\n"'

clanky workspace download <WORKSPACE_ID_OR_EXACT_NAME> /tmp/report.bin
clanky workspace download <WORKSPACE_ID_OR_EXACT_NAME> packages/app/dist/app.tar.gz \
  --output ./app.tar.gz
```

`workspace exec` is the preferred path for one-shot, non-interactive commands.
It invokes the executable with a separate argument array, waits for completion,
prints remote stdout to stdout and stderr to stderr, and returns the remote
process exit code. Put `--` before the remote command so its options are not
parsed as Clanky options. Use `--cwd PATH` to select the working directory and
`--timeout MS` to override the default timeout. The command is not run through
an implicit shell; invoke `sh -lc` or another shell explicitly when shell
syntax is intentional. A non-zero remote exit is a normal command result, not
an authentication or transport failure.

`workspace download` is the preferred path for binary files and streams the
response directly to a local file. If `--output` is omitted, the remote
basename is used in the current directory. Use `--output -` to write bytes to
stdout, and `--force` to allow replacing an existing local file. Do not use
`clanky api` for downloads because that command parses responses as JSON/text.

The workspace is an execution-host selector, not a filesystem sandbox.
Relative `--cwd` and download paths start at the configured workspace directory;
absolute paths refer directly to the selected host and may be outside that
directory. `workspace exec` buffers stdout and stderr with an 8 MiB limit per
stream. For larger output, redirect it to a file on the host and download that
file; downloads have no application-level 8 MiB limit and are streamed.

Both commands resolve an exact workspace ID first, then an exact
case-sensitive workspace name. Names must be unique. They use the selected
profile's credentials, or the `CLANKY_BASE_URL`/`CLANKY_API_KEY` environment
pair. `clanky ws` remains the realtime event bridge and is not a command
execution or file-transfer transport.

## Querying Clanky state

Start broad, then narrow down by ID:

```bash
clanky api
clanky schema workspaces
clanky api workspaces --method GET
clanky schema tasks
clanky api tasks --method GET
clanky api tasks/<task-id> --method GET
```

If JSON tooling is available, parse the response instead of relying on visual inspection:

```bash
clanky api tasks --method GET | jq .
clanky api workspaces --method GET | jq .
```

## Creating a task

Before creating a task, discover the exact current schema:

```bash
clanky schema tasks
clanky api workspaces --method GET
```

Then create the task with a payload that matches the schema returned by the instance. A typical task payload includes a workspace ID, name, prompt, model, worktree behavior, and planning behavior:

```bash
clanky api tasks --method POST --payload '{
  "name": "implement-dark-mode-toggle",
  "workspaceId": "ws-abc123",
  "prompt": "Implement a dark mode toggle in the settings page. Use existing app patterns and verify the behavior.",
  "attachments": [],
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514",
    "variant": ""
  },
  "cheapModel": { "mode": "same-as-task" },
  "useWorktree": true,
  "planMode": true,
  "maxIterations": 10,
  "maxConsecutiveErrors": 10,
  "activityTimeoutSeconds": null,
  "stopPattern": "<promise>COMPLETE</promise>$",
  "git": { "branchPrefix": "", "commitScope": "" },
  "baseBranch": "main",
  "clearPlanningFolder": false,
  "autoAcceptPlan": false,
  "fullyAutonomous": false,
  "draft": false
}'
```

After creation, inspect the returned JSON for the task ID and status. Then monitor it:

```bash
clanky api tasks/<task-id> --method GET
clanky ws
```

If the schema or endpoint list differs from this example, follow the local `clanky api` and `clanky schema` output instead of forcing the example.

## Working with chats, agents, and other entities

Clanky may expose chats, agents, SSH sessions, previews, provisioning jobs, or other entity APIs depending on the version and instance configuration. Discover them first:

```bash
clanky api
```

Then inspect relevant schemas before making changes:

```bash
clanky schema chats
clanky schema agents
clanky schema workspaces
```

If an entity endpoint exists, use the same pattern:

```bash
clanky api <entity> --method GET
clanky schema <entity>
clanky api <entity> --method POST --payload '<json matching the schema>'
clanky api <entity>/<id> --method GET
```

For live updates, use the generic JSON-lines realtime bridge:

```bash
clanky ws
```

## Error handling and durable behavior

- If a command fails with "unknown option" or "unknown command", run `clanky help` and adapt to the available command surface.
- If an API call fails validation, run `clanky schema <endpoint>` and rebuild the payload from the current schema.
- If authentication fails, report that the existing CLI credentials are missing, expired, or for the wrong instance; do not start a new setup flow unless asked.
- If an endpoint is absent, say it is not exposed by this Clanky instance/version and use the closest discoverable endpoint.
- When creating or modifying data, prefer reading the current resource first, then send the smallest payload required by the schema.
- For long-running tasks, prefer `clanky ws` for progress instead of repeatedly polling.

## What not to do

- Do not install Clanky.
- Do not start or restart a Clanky server.
- Do not assume server URLs, workspace IDs, task IDs, model IDs, or provider IDs; discover them from the instance.
- Do not hardcode old CLI behavior when `clanky help`, `clanky api`, or `clanky schema` says otherwise.
