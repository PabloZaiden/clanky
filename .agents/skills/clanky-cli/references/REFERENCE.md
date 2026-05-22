# `clanky-cli` reference

This reference expands on the main skill with concrete commands and common workflows.

## Installation and maintenance

Check the installed client:

```bash
clanky-cli version
```

Install if missing:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/clanky/main/install.sh | sh
```

Check for updates:

```bash
clanky-cli update --check
```

Update the installed published binary in place:

```bash
clanky-cli update
```

Install a specific published release:

```bash
clanky-cli update --version v0.8.1
```

## Authentication workflow

Check auth state:

```bash
clanky-cli status
clanky-cli status http://localhost:3000
```

Authenticate against a server:

```bash
clanky-cli auth http://localhost:3000
```

Optional auth flags:

```bash
clanky-cli auth http://localhost:3000 --client-id my-agent
clanky-cli auth http://localhost:3000 --cookies 'session=value; other=value'
```

What the auth commands mean:

- `status` validates stored credentials through `GET /api/auth/status`.
- `auth` starts the device flow through `POST /api/auth/device`, then polls `POST /api/auth/token` until approval completes.
- Credentials are stored under `~/.clanky/cli-auth.json` by default.

## Discovery-first workflow

List discoverable endpoints:

```bash
clanky-cli api
```

Inspect the schema for an endpoint before writing data:

```bash
clanky-cli schema auth/device
clanky-cli schema tasks
clanky-cli schema tasks/my-task/pending
clanky-cli schema chats/my-chat/messages
clanky-cli schema workspaces/my-workspace/files/write
```

Endpoint normalization examples:

```bash
clanky-cli schema tasks
clanky-cli schema /tasks
clanky-cli schema api/tasks
clanky-cli schema /api/tasks
```

Those all target the same endpoint.

## API command behavior

General form:

```bash
clanky-cli api <endpoint> [--method <method>] [--payload '<json>']
```

Examples:

```bash
clanky-cli api tasks
clanky-cli api tasks/my-task
clanky-cli api workspaces
clanky-cli api auth/status
```

Mutating example pattern:

```bash
clanky-cli schema tasks/my-task/pending
clanky-cli api tasks/my-task/pending --method POST --payload '<json matching the schema>'
```

Output shape:

```json
{
  "status": {
    "code": 200,
    "text": "OK",
    "ok": true
  },
  "response": {}
}
```

If `--payload` is invalid JSON, the CLI rejects the call before sending the request.

## Common endpoint families

Use `clanky-cli api` to list the full catalog. These families are usually the most relevant.

### Auth and sessions

```bash
clanky-cli api auth/status
clanky-cli api auth/sessions
clanky-cli schema auth/issuer
```

### Tasks

Read and inspect task state:

```bash
clanky-cli api tasks
clanky-cli api tasks/my-task
clanky-cli api tasks/my-task/plan
clanky-cli api tasks/my-task/status-file
clanky-cli api tasks/my-task/diff
clanky-cli api tasks/my-task/comments
clanky-cli api tasks/my-task/review-history
```

Inspect write-capable task endpoints before using them:

```bash
clanky-cli schema tasks
clanky-cli schema tasks/my-task
clanky-cli schema tasks/my-task/plan/feedback
clanky-cli schema tasks/my-task/pending
clanky-cli schema tasks/my-task/pending-prompt
clanky-cli schema tasks/my-task/follow-up
clanky-cli schema tasks/my-task/draft/start
clanky-cli schema tasks/my-task/address-comments
```

Examples of task control endpoints that usually do not take a request body:

```bash
clanky-cli api tasks/my-task/accept --method POST
clanky-cli api tasks/my-task/push --method POST
clanky-cli api tasks/my-task/update-branch --method POST
clanky-cli api tasks/my-task/mark-merged --method POST
clanky-cli api tasks/my-task/manual-complete --method POST
clanky-cli api tasks/my-task/stop --method POST
clanky-cli api tasks/my-task/discard --method POST
clanky-cli api tasks/my-task/purge --method DELETE
```

### Chats

```bash
clanky-cli api chats
clanky-cli api chats/my-chat
clanky-cli schema chats
clanky-cli schema chats/my-chat
clanky-cli schema chats/my-chat/messages
clanky-cli schema chats/my-chat/interrupt
```

### Workspaces and files

```bash
clanky-cli api workspaces
clanky-cli api workspaces/my-workspace
clanky-cli api workspaces/my-workspace/server-settings/status
clanky-cli api workspaces/my-workspace/agents-md
clanky-cli schema workspaces
clanky-cli schema workspaces/my-workspace
clanky-cli schema workspaces/my-workspace/server-settings
clanky-cli schema workspaces/my-workspace/server-settings/test
clanky-cli schema workspaces/my-workspace/files
clanky-cli schema workspaces/my-workspace/files/content
clanky-cli schema workspaces/my-workspace/files/tree
clanky-cli schema workspaces/my-workspace/files/write
```

### SSH and provisioning

```bash
clanky-cli api ssh-servers
clanky-cli api ssh-sessions/my-session
clanky-cli api provisioning-jobs/my-job
clanky-cli api provisioning-jobs/my-job/logs
clanky-cli schema ssh-servers
clanky-cli schema ssh-servers/my-server
clanky-cli schema ssh-servers/my-server/sessions
clanky-cli schema ssh-servers/my-server/prerequisites/check
clanky-cli schema provisioning-jobs
```

### Settings and administrative endpoints

Use these only when the task clearly requires them:

```bash
clanky-cli api settings/reset-all --method POST
clanky-cli api server/kill --method POST
```

## Websocket streaming

General form:

```bash
clanky-cli ws [base-url] [--task-id <id>] [--chat-id <id>] [--ssh-session-id <id>] [--ssh-server-session-id <id>] [--provisioning-job-id <id>]
```

Examples:

```bash
clanky-cli ws --task-id my-task
clanky-cli ws http://localhost:3000 --chat-id my-chat
clanky-cli ws --ssh-session-id ssh-123
clanky-cli ws --provisioning-job-id job-123
```

Websocket behavior:

- The command connects to `/api/ws`.
- It sends the stored bearer token and cookies automatically.
- Text frames are printed to stdout.
- Non-empty stdin lines must each be a valid JSON value.

Example stdin usage:

```bash
printf '%s\n' '{"type":"ping"}' | clanky-cli ws --task-id my-task
```

## Troubleshooting

### `Not logged in.`

Run:

```bash
clanky-cli auth <base-url>
```

### `Stored credentials are invalid.`

Re-authenticate:

```bash
clanky-cli auth <base-url>
```

### `Unknown API endpoint`

Refresh your view of the catalog:

```bash
clanky-cli api
```

Then inspect the endpoint shape:

```bash
clanky-cli schema <endpoint>
```

### `Invalid JSON for --payload`

Fix the JSON string first, then retry. Keep payloads compact and quote them as a single shell argument.

## Recommended operating pattern

1. Ensure `clanky-cli` exists.
2. Run `clanky-cli status`.
3. If needed, run `clanky-cli auth <base-url>`.
4. Run `clanky-cli api` to discover the available surface.
5. Run `clanky-cli schema <endpoint>` before any write.
6. Call the endpoint with `clanky-cli api ...`.
7. Use `clanky-cli ws ...` when you need live updates.
