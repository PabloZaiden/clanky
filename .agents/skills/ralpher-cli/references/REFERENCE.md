# `ralpher-cli` reference

This reference expands on the main skill with concrete commands and common workflows.

## Installation and maintenance

Check the installed client:

```bash
ralpher-cli version
```

Install if missing:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/ralpher/main/install.sh | sh
```

Check for updates:

```bash
ralpher-cli update --check
```

Update the installed published binary in place:

```bash
ralpher-cli update
```

Install a specific published release:

```bash
ralpher-cli update --version v0.8.1
```

## Authentication workflow

Check auth state:

```bash
ralpher-cli status
ralpher-cli status http://localhost:3000
```

Authenticate against a server:

```bash
ralpher-cli auth http://localhost:3000
```

Optional auth flags:

```bash
ralpher-cli auth http://localhost:3000 --client-id my-agent
ralpher-cli auth http://localhost:3000 --cookies 'session=value; other=value'
```

What the auth commands mean:

- `status` validates stored credentials through `GET /api/auth/status`.
- `auth` starts the device flow through `POST /api/auth/device`, then polls `POST /api/auth/token` until approval completes.
- Credentials are stored under `~/.ralpher/cli-auth.json` by default.

## Discovery-first workflow

List discoverable endpoints:

```bash
ralpher-cli api
```

Inspect the schema for an endpoint before writing data:

```bash
ralpher-cli schema auth/device
ralpher-cli schema loops
ralpher-cli schema loops/my-loop/pending
ralpher-cli schema chats/my-chat/messages
ralpher-cli schema workspaces/my-workspace/files/write
```

Endpoint normalization examples:

```bash
ralpher-cli schema loops
ralpher-cli schema /loops
ralpher-cli schema api/loops
ralpher-cli schema /api/loops
```

Those all target the same endpoint.

## API command behavior

General form:

```bash
ralpher-cli api <endpoint> [--method <method>] [--payload '<json>']
```

Examples:

```bash
ralpher-cli api loops
ralpher-cli api loops/my-loop
ralpher-cli api workspaces
ralpher-cli api auth/status
```

Mutating example pattern:

```bash
ralpher-cli schema loops/my-loop/pending
ralpher-cli api loops/my-loop/pending --method POST --payload '<json matching the schema>'
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

Use `ralpher-cli api` to list the full catalog. These families are usually the most relevant.

### Auth and sessions

```bash
ralpher-cli api auth/status
ralpher-cli api auth/sessions
ralpher-cli schema auth/issuer
```

### Loops

Read and inspect loop state:

```bash
ralpher-cli api loops
ralpher-cli api loops/my-loop
ralpher-cli api loops/my-loop/plan
ralpher-cli api loops/my-loop/status-file
ralpher-cli api loops/my-loop/diff
ralpher-cli api loops/my-loop/comments
ralpher-cli api loops/my-loop/review-history
```

Inspect write-capable loop endpoints before using them:

```bash
ralpher-cli schema loops
ralpher-cli schema loops/my-loop
ralpher-cli schema loops/my-loop/plan/feedback
ralpher-cli schema loops/my-loop/pending
ralpher-cli schema loops/my-loop/pending-prompt
ralpher-cli schema loops/my-loop/follow-up
ralpher-cli schema loops/my-loop/draft/start
ralpher-cli schema loops/my-loop/address-comments
```

Examples of loop control endpoints that usually do not take a request body:

```bash
ralpher-cli api loops/my-loop/accept --method POST
ralpher-cli api loops/my-loop/push --method POST
ralpher-cli api loops/my-loop/update-branch --method POST
ralpher-cli api loops/my-loop/mark-merged --method POST
ralpher-cli api loops/my-loop/manual-complete --method POST
ralpher-cli api loops/my-loop/stop --method POST
ralpher-cli api loops/my-loop/discard --method POST
ralpher-cli api loops/my-loop/purge --method DELETE
```

### Chats

```bash
ralpher-cli api chats
ralpher-cli api chats/my-chat
ralpher-cli schema chats
ralpher-cli schema chats/my-chat
ralpher-cli schema chats/my-chat/messages
ralpher-cli schema chats/my-chat/interrupt
```

### Workspaces and files

```bash
ralpher-cli api workspaces
ralpher-cli api workspaces/my-workspace
ralpher-cli api workspaces/my-workspace/server-settings/status
ralpher-cli api workspaces/my-workspace/agents-md
ralpher-cli schema workspaces
ralpher-cli schema workspaces/my-workspace
ralpher-cli schema workspaces/my-workspace/server-settings
ralpher-cli schema workspaces/my-workspace/server-settings/test
ralpher-cli schema workspaces/my-workspace/files
ralpher-cli schema workspaces/my-workspace/files/content
ralpher-cli schema workspaces/my-workspace/files/tree
ralpher-cli schema workspaces/my-workspace/files/write
```

### SSH and provisioning

```bash
ralpher-cli api ssh-servers
ralpher-cli api ssh-sessions/my-session
ralpher-cli api provisioning-jobs/my-job
ralpher-cli api provisioning-jobs/my-job/logs
ralpher-cli schema ssh-servers
ralpher-cli schema ssh-servers/my-server
ralpher-cli schema ssh-servers/my-server/sessions
ralpher-cli schema ssh-servers/my-server/prerequisites/check
ralpher-cli schema provisioning-jobs
```

### Settings and administrative endpoints

Use these only when the task clearly requires them:

```bash
ralpher-cli api settings/reset-all --method POST
ralpher-cli api server/kill --method POST
```

## Websocket streaming

General form:

```bash
ralpher-cli ws [base-url] [--loop-id <id>] [--chat-id <id>] [--ssh-session-id <id>] [--ssh-server-session-id <id>] [--provisioning-job-id <id>]
```

Examples:

```bash
ralpher-cli ws --loop-id my-loop
ralpher-cli ws http://localhost:3000 --chat-id my-chat
ralpher-cli ws --ssh-session-id ssh-123
ralpher-cli ws --provisioning-job-id job-123
```

Websocket behavior:

- The command connects to `/api/ws`.
- It sends the stored bearer token and cookies automatically.
- Text frames are printed to stdout.
- Non-empty stdin lines must each be a valid JSON value.

Example stdin usage:

```bash
printf '%s\n' '{"type":"ping"}' | ralpher-cli ws --loop-id my-loop
```

## Troubleshooting

### `Not logged in.`

Run:

```bash
ralpher-cli auth <base-url>
```

### `Stored credentials are invalid.`

Re-authenticate:

```bash
ralpher-cli auth <base-url>
```

### `Unknown API endpoint`

Refresh your view of the catalog:

```bash
ralpher-cli api
```

Then inspect the endpoint shape:

```bash
ralpher-cli schema <endpoint>
```

### `Invalid JSON for --payload`

Fix the JSON string first, then retry. Keep payloads compact and quote them as a single shell argument.

## Recommended operating pattern

1. Ensure `ralpher-cli` exists.
2. Run `ralpher-cli status`.
3. If needed, run `ralpher-cli auth <base-url>`.
4. Run `ralpher-cli api` to discover the available surface.
5. Run `ralpher-cli schema <endpoint>` before any write.
6. Call the endpoint with `ralpher-cli api ...`.
7. Use `ralpher-cli ws ...` when you need live updates.
