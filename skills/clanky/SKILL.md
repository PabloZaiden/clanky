---
name: clanky
description: Use the Clanky CLI to inspect and operate an authenticated Clanky instance, or to bootstrap and configure a Mesh execution worker when explicitly requested. Activate when a user wants to query Clanky state, discover available Clanky API endpoints, create or monitor tasks, interact with chats or agents, stream events, automate Clanky through the `clanky` command, or enroll a headless Mesh worker.
compatibility: Requires `clanky` on PATH. Normal operations require existing CLI authentication and access to the target instance; worker bootstrap initializes its own API-key access.
---

# Clanky CLI usage for agents

Use this skill when you need to operate an existing Clanky instance from a terminal through the `clanky` CLI. Assume Clanky is already installed, configured, authenticated, and reachable unless the user explicitly asks to bootstrap or configure a Mesh worker. Do not install Clanky, start a server, or guide the user through authentication unless the user explicitly asks for that.

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

## Bootstrapping a Mesh worker

Use this flow only when the user explicitly asks to configure an installation
as a headless Mesh execution node. The canonical detailed guide is
[`docs/mesh-worker.md`](../../docs/mesh-worker.md); prefer its current commands
and troubleshooting information over memorized behavior.

A Mesh worker uses the normal `clanky` binary but exposes only health, signed
Mesh transport, and approved API-key-authenticated Mesh control operations. It
does not expose the browser application, passkeys, device authorization,
realtime UI, or unrelated APIs. Do not combine worker mode with
`CLANKY_DISABLE_PASSKEY`.

1. On the worker host, bootstrap its local configuration:

   ```bash
   clanky worker bootstrap \
     --host 0.0.0.0 \
     --port 3000 \
     --worker-directory /workspaces \
     --instance-name worker-1 \
     --mesh-endpoint https://worker.example.com
   ```

   The data directory defaults to `$HOME/.clanky`; use `CLANKY_DATA_DIR` only
   when an alternate location is required. The bootstrap persists the bind
   host, port, worker directory, advertised endpoint, and worker identity.
   The instance name is required and is the name controllers display for this
   worker.
   Mesh execution resolves relative directories and paths against the
   configured worker directory; absolute paths are used directly.
   `--mesh-endpoint` must be a public DNS name or a stable IP reachable from
   the controller. For the common direct-worker case without DNS, include the
   port, for example `--mesh-endpoint http://203.0.113.10:3000`, bind with
   `--host 0.0.0.0`, and allow or forward that port through the firewall/NAT.
   Do not use `127.0.0.1` or an unroutable private address. Use HTTPS across
   untrusted networks.
   The worker username is fixed internally. The bootstrap API key is printed
   only when first created or rotated and is not needed for enrollment.
   To replace a lost API key, repeat the same command with `--rotate`.

2. Install and start the native service on the worker:

   ```bash
   clanky worker service install
   clanky worker service status
   ```

   If bootstrap used `CLANKY_DATA_DIR`, use the same override for this command.
   On macOS, the worker process starts an asynchronous permission preflight
   when the LaunchAgent starts it. It requests Accessibility, Screen Recording,
   and direct screen capture access for screenshots. It also performs one
   non-interactive `screencapture` probe so macOS can show its screen/audio
   capture consent before an agent needs a screenshot, then probes Desktop,
   Documents, and Downloads for Files and Folders access. Mesh serves
   immediately and keeps working if a prompt is denied, ignored, or times out;
   failures are logged. This must run in the logged-in user session so macOS
   associates consent with the service process rather than the terminal used
   to install it. Full Disk Access is intentionally not requested. The service
   then reads the persisted worker configuration and starts the restricted Mesh
   surface.

3. On the controller, create a short-lived enrollment token:

   ```bash
   clanky mesh enrollment-token create --name worker-1 --ttl-seconds 900
   ```

   The JSON response contains `response.workerJoinCommand`, a single-line
   command containing the controller endpoint, token, and fingerprint.

4. Copy that property and run it on the worker:

   ```bash
   clanky worker join --controller 'https://controller.example.com' --token '<single-use-token>' --fingerprint '<controller-fingerprint>'
   ```

   `worker join` uses the worker's local identity. Do not copy its API key,
   `CLANKY_BASE_URL`, or other worker-local environment variables to the
   controller.

5. Verify from the controller:

   ```bash
   clanky mesh status
   ```

   The worker should be active and available as an execution target.
   From the controller's Mesh settings, use the enrolled worker's **Kill**
   action to make the worker process exit; its LaunchAgent or systemd
   supervisor should restart it without revoking the grant.

Mesh access intentionally grants unrestricted command and file access to the
worker host. Do not invent path sandboxing or assume a workspace confines Mesh
operations.

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

clanky workspace upload <WORKSPACE_ID_OR_EXACT_NAME> ./app.tar.gz \
  --remote-path packages/app/dist/app.tar.gz --force
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

`workspace upload` is the preferred path for sending one regular local file to
the execution host. It uses the existing streamed upload session with
replayable 8 MiB chunks, up to three attempts per chunk, progress-independent
offsets, and atomic completion. Pass `--remote-path PATH` to choose the
destination; without it, the local basename is placed in the workspace
directory. Relative remote paths start at the workspace directory, while
absolute paths are used directly on the selected host. The destination
directory must already exist, and `--force` is required to replace an existing
file. Uploads are not recursive and do not read stdin.

The workspace is an execution-host selector, not a filesystem sandbox.
Relative `--cwd` and download paths start at the configured workspace directory;
absolute paths refer directly to the selected host and may be outside that
directory. `workspace exec` buffers stdout and stderr with an 8 MiB limit per
stream. For larger output, redirect it to a file on the host and download that
file; downloads have no application-level 8 MiB limit and are streamed.
Uploads likewise have no total 8 MiB limit; 8 MiB is only the default chunk
size. Local, SSH, and Mesh-selected workspaces use the same commands and
transfer semantics.

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
- Do not start or restart a Clanky server unless the user explicitly asks for
  lifecycle or Mesh-worker setup.
- Do not assume server URLs, workspace IDs, task IDs, model IDs, or provider IDs; discover them from the instance.
- Do not hardcode old CLI behavior when `clanky help`, `clanky api`, or `clanky schema` says otherwise.
