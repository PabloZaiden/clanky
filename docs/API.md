# Clanky HTTP and CLI reference

This document describes the REST API for the Clanky Task Management System.

## Base URL

```
http://localhost:3000/api
```

The port can be configured via the `CLANKY_PORT` environment variable, and the bind host can be configured via `CLANKY_HOST`.

## Authentication

Browser sessions use passkeys. CLI and automation clients can use device
credentials or API keys. This document covers Clanky domain endpoints; the
framework-owned authentication and health endpoints are listed separately
where they affect integration.

`clanky auth` uses the framework device flow, `clanky api` sends authenticated REST calls with selected framework credentials, `clanky ws` opens an authenticated JSON-lines websocket session against `/api/ws`, `clanky schema` exposes discoverability metadata for catalogued Clanky endpoints, and `clanky update` checks or installs published Clanky release binaries from GitHub Releases.

## Route security and discovery metadata

Normal private REST routes require an authenticated user and enforce
same-origin protection for browser mutations. Database reset and terminal-task
purge are owner-only. Preview and terminal WebSocket upgrades require an
authenticated user and always enforce same-origin checks.

Use `clanky api` to list the routes exposed by the running server and
`clanky schema <endpoint>` to inspect a route's request, response, and CLI
metadata. Public routes are exceptional and are identified explicitly in the
route reference.

## CLI discovery helpers

The standalone `clanky` binary exposes the server and API discovery directly:

```bash
# Start the embedded local server
clanky serve

# Print the installed CLI version
clanky version

# Check whether a newer published binary is available
clanky update --check

# Update the installed release binaries in place
clanky update

# Authenticate against a server
clanky auth --base-url http://localhost:3000

# List discoverable endpoints
clanky api

# Invoke an authenticated API request (prints one JSON object)
clanky api tasks/my-task --method GET

# Inspect the schema metadata for an endpoint
clanky schema tasks

# Stream websocket events over stdio
clanky ws
```

`clanky api <endpoint>` emits a single JSON envelope so scripts can parse the
result consistently. `clanky ws` writes inbound frames to stdout one line at a
time, reads one JSON value per non-empty stdin line, and sends diagnostics to
stderr.

Example CLI output:

```json
{
  "status": {
    "code": 200,
    "text": "OK",
    "ok": true
  },
  "response": {
    "id": "my-task",
    "status": "running"
  }
}
```

## Response Format

JSON API responses return the requested data directly on success. Error
responses from JSON endpoints follow this format:

```json
{
  "error": "error_code",
  "message": "Human-readable error description"
}
```

Transcript downloads, file downloads, and raw websocket/streaming endpoints
use their documented content type instead of this JSON format.

## Workspaces and agent sessions

Agent sessions use the provider selected for the workspace. A workspace can
run locally, over SSH, or through a Mesh worker. Git, file, and command
operations run on that workspace's execution host, while the API and
application data remain on the controller.

### Direct execution-host commands

`POST /api/execution-hosts/:kind/:id/exec` runs one bounded, non-interactive
command on a registered local, Mesh, or SSH execution host. The `:id` value is
the host source ID returned by `GET /api/execution-hosts`; for Mesh hosts this
is the worker node ID. The endpoint uses the same command, argument, cwd,
timeout, output-limit, and exit-code semantics as
`POST /api/workspaces/:id/exec`.

```bash
clanky server exec "worker-1" --cwd /var/log --timeout 10000 -- pwd
clanky server exec mesh:worker-1 -- journalctl -u clanky-worker --no-pager
```

The operation does not start a persistent shell. Use the terminal endpoints
for interactive sessions. SSH hosts can receive the temporary credential token
issued by Clanky through `--credential-token TOKEN`.

## Endpoints

### Current Clanky route inventory

The table below is the public Clanky-owned route catalog. Use
`clanky schema <endpoint>` for request and response details, and `clanky api`
for the endpoint list exposed by the running server. Framework-owned routes
such as `/api/auth/*`, `/api/config`, `/api/health`, and `/api/ws` are not
included in this table.

<details>
<summary>Show all catalogued Clanky routes</summary>

| Method(s) | Path | Description |
|-----------|------|-------------|
| GET, DELETE | `/api/agent-runs/:id` | Read or delete an agent run. |
| GET | `/api/agent-runs/:id/snapshot` | Read the complete lightweight transcript snapshot for an agent run. |
| GET | `/api/agent-runs/:id/tool-calls/:toolCallId` | Read one complete agent-run tool-call payload. |
| GET, POST | `/api/agents` | List or create scheduled agents. |
| GET, PATCH, DELETE | `/api/agents/:id` | Read, update, or delete a scheduled agent. |
| GET | `/api/agents/:id/code/draft` | Read the current generated deterministic agent draft. |
| GET | `/api/agents/:id/export` | Download a portable scheduled-agent configuration. |
| POST | `/api/agents/:id/code/generate` | Generate an editable deterministic agent program without saving it. |
| POST | `/api/agents/:id/code/generate/prepare` | Prepare the hidden deterministic-agent generation conversation before a long generation request. |
| POST | `/api/agents/:id/interrupt` | Interrupt an active agent run. |
| POST | `/api/agents/:id/pause` | Pause a scheduled agent. |
| POST | `/api/agents/:id/resume` | Resume a paused scheduled agent. |
| POST | `/api/agents/:id/run` | Start an agent run immediately. |
| GET, DELETE | `/api/agents/:id/runs` | List or purge runs for an agent. |
| POST | `/api/agents/code/generate` | Reject generation for unsaved agents. |
| POST | `/api/agents/code/test` | Test deterministic agent code without saving an agent or run. |
| POST | `/api/agents/code/test/stream` | Stream deterministic agent code test output without saving an agent or run. |
| GET, POST | `/api/chats` | List chats or create a chat session. |
| GET, PATCH, DELETE | `/api/chats/:id` | Read, update, or delete a chat session; remote cleanup may continue after deletion. |
| POST | `/api/chats/:id/done` | Mark a standalone chat as done. |
| POST | `/api/chats/:id/interrupt` | Interrupt an active chat run. |
| POST | `/api/chats/:id/messages` | Send a message to a chat session. |
| POST | `/api/chats/:id/permissions/:requestId` | Approve or deny a pending chat permission request. |
| DELETE | `/api/chats/:id/queued-messages/:messageId` | Delete a queued chat message. |
| POST | `/api/chats/:id/reconnect` | Reconnect a chat session to its backend runtime. |
| GET | `/api/chats/:id/snapshot` | Read the complete lightweight transcript snapshot for a chat. |
| POST | `/api/chats/:id/spawn-task` | Create a task from an existing chat transcript. |
| POST | `/api/chats/:id/spawn-task-from-current-plan` | Create a task from the current plan discussed in a chat. |
| GET | `/api/chats/:id/tool-calls/:toolCallId` | Read the full details for one chat tool call. |
| GET | `/api/chats/:id/transcript.html` | Open a chat transcript as a standalone HTML document. |
| GET | `/api/chats/:id/transcript.md` | Download a chat transcript as Markdown. |
| POST | `/api/chats/import` | Import an existing chat session. |
| GET | `/api/chats/importable-sessions` | List chat sessions available for import. |
| GET | `/api/check-planning-dir` | Inspect a workspace's `.clanky-planning` files. |
| GET | `/api/execution-hosts` | List execution hosts available to the current user. |
| POST | `/api/execution-hosts/:kind/:id/exec` | Execute one non-interactive command on a registered execution host. |
| GET, POST | `/api/execution-hosts/:kind/:id/working-directory` | Resolve the configured or current execution-host directory. |
| POST | `/api/execution-hosts/:kind/:id/addresses` | List accessible IPv4 addresses on an execution host. |
| PATCH | `/api/execution-hosts/:kind/:id/configuration` | Update node-owned defaults for a local or Mesh execution host. |
| POST | `/api/execution-hosts/:kind/:id/chats` | Create a direct chat on an execution host. |
| POST | `/api/execution-hosts/:kind/:id/prerequisites` | Check prerequisites on an execution host. |
| POST | `/api/execution-hosts/:kind/:id/devbox-templates` | List Devbox templates on an execution host. |
| POST | `/api/execution-hosts/:kind/:id/chat-providers` | Discover ACP providers available on an execution host. |
| POST | `/api/execution-hosts/:kind/:id/chat-models` | Discover ACP models for a provider on an execution host. |
| GET | `/api/execution-hosts/:kind/:id/files` | List execution-host files in the active explorer root. |
| GET | `/api/execution-hosts/:kind/:id/files/content` | Read an execution-host file. |
| POST | `/api/execution-hosts/:kind/:id/files/delete` | Delete an execution-host file or directory. |
| GET, HEAD | `/api/execution-hosts/:kind/:id/files/download` | Download an execution-host file. |
| GET | `/api/execution-hosts/:kind/:id/files/metadata` | Read execution-host file metadata. |
| GET | `/api/execution-hosts/:kind/:id/files/preview` | Preview a browser-renderable execution-host image file. |
| POST | `/api/execution-hosts/:kind/:id/files/rename` | Rename an execution-host file or directory. |
| GET | `/api/execution-hosts/:kind/:id/files/tree` | Load the full execution-host file tree. |
| POST | `/api/execution-hosts/:kind/:id/files/write` | Write an execution-host file. |
| POST | `/api/execution-hosts/:kind/:id/files/upload` | Create an execution-host file upload session. |
| POST | `/api/execution-hosts/:kind/:id/files/upload/cancel` | Cancel an execution-host file upload session. |
| POST | `/api/execution-hosts/:kind/:id/files/upload/chunk` | Upload a chunk for an execution-host file upload session. |
| POST | `/api/execution-hosts/:kind/:id/files/upload/complete` | Complete an execution-host file upload session. |
| GET | `/api/git/branches` | List local git branches for a workspace. |
| GET | `/api/git/default-branch` | Detect the default git branch for a workspace. |
| GET | `/api/git/github-issues` | List open GitHub issues for a workspace repository. |
| GET | `/api/git/github-repository-url` | Resolve the GitHub repository URL for a workspace. |
| GET | `/api/git/remote-status` | Check whether a git remote exists for a workspace. |
| POST | `/api/mesh/endpoint` | Set this controller or worker advertised Mesh endpoint. |
| POST | `/api/mesh/enroll` | Enroll this worker with a controller. |
| GET, POST | `/api/mesh/enrollment-tokens` | List or create single-use worker enrollment tokens. |
| POST | `/api/mesh/health` | Probe enrolled workers without changing durable trust. |
| POST | `/api/mesh/instance-name` | Set this controller or worker display name. |
| GET, POST, DELETE | `/api/mesh/relay` | Inspect, pair, or unpair this controller's Mesh relay. |
| GET | `/api/mesh/status` | Get this controller's workers or this worker's local status. |
| DELETE | `/api/mesh/workers/:workerNodeId` | Delete a revoked worker registration. |
| POST | `/api/mesh/workers/:workerNodeId/kill` | Ask an enrolled worker to terminate so its service supervisor can restart it. |
| POST | `/api/mesh/workers/revoke` | Revoke one controller-to-worker grant. |
| GET | `/api/models` | List available AI models for a workspace. |
| GET | `/api/models/variants` | List available model variants for a workspace. |
| GET, PUT | `/api/preferences/dashboard-view-mode` | Persist the preferred dashboard layout. |
| GET, PUT | `/api/preferences/file-explorer-full-tree` | Persist file explorer tree loading preferences. |
| GET, PUT | `/api/preferences/github-username` | Persist the user's optional GitHub username. |
| GET, PUT | `/api/preferences/last-cheap-model` | Persist the user's most recently used cheap model. |
| GET, PUT | `/api/preferences/last-directory` | Persist the user's last selected directory. |
| GET, PUT | `/api/preferences/last-model` | Persist the user's most recently used model. |
| GET, PUT | `/api/preferences/markdown-rendering` | Persist markdown rendering preferences. |
| GET, PUT | `/api/preferences/quick-chat` | Persist quick chat workspace and model preferences. |
| GET, PUT | `/api/preferences/scheduler-timezone` | Persist the scheduler timezone preference. |
| GET | `/api/previews` | List all active workspace and direct server previews. |
| DELETE | `/api/previews/:previewId` | Close an active workspace or direct server preview. |
| GET | `/api/previews/bridge` | Open the raw websocket bridge for a workspace or direct server preview. |
| POST | `/api/provisioning-jobs` | Start a remote provisioning job. |
| POST | `/api/provisioning-jobs/:id/dismiss` | Dismiss a completed, failed, cancelled, or interrupted provisioning job. |
| GET, DELETE | `/api/provisioning-jobs/:id` | Read or cancel a remote provisioning job. |
| GET | `/api/provisioning-jobs/:id/logs` | Read logs for a remote provisioning job. |
| POST | `/api/server-settings/test` | Test a server connection without creating a workspace. |
| POST | `/api/settings/purge-terminal-tasks` | Purge terminal-state tasks across all workspaces. |
| POST | `/api/settings/reset-all` | Reset all persisted settings and recreate the database. |
| GET, POST | `/api/ssh-servers` | List or create standalone SSH servers. |
| GET, PATCH, DELETE | `/api/ssh-servers/:id` | Update or delete a standalone SSH server. |
| POST | `/api/ssh-servers/:id/credentials` | Exchange an encrypted SSH credential for a temporary token. |
| GET | `/api/ssh-servers/:id/public-key` | Read the public key for a standalone SSH server. |
| GET, POST | `/api/terminal-sessions` | List or create a workspace or direct execution-host terminal session. |
| GET, PATCH, DELETE | `/api/terminal-sessions/:id` | Read, update, or delete a terminal session. |
| GET | `/api/terminal` | Open the raw websocket bridge for a terminal session. |
| GET, POST | `/api/tasks` | List tasks or create a new task. |
| GET, PUT, PATCH, DELETE | `/api/tasks/:id` | Read, update, or delete a task. |
| POST | `/api/tasks/:id/accept` | Accept a completed or max-iteration task locally without pushing. |
| POST | `/api/tasks/:id/address-comments` | Address review comments for a task. |
| POST | `/api/tasks/:id/automatic-pr-flow/start` | Enable automatic pull request monitoring for a task. |
| POST | `/api/tasks/:id/automatic-pr-flow/stop` | Disable automatic pull request monitoring for a task. |
| GET, POST | `/api/tasks/:id/chat` | Read or create the chat session attached to a task. |
| POST | `/api/tasks/:id/close-local` | Close a locally accepted task without PR actions. |
| GET | `/api/tasks/:id/comments` | List review comments for a task. |
| GET | `/api/tasks/:id/diff` | Read the git diff produced by a task. |
| POST | `/api/tasks/:id/discard` | Discard a task and remove its working branch. |
| POST | `/api/tasks/:id/draft/start` | Start draft generation for a task. |
| POST | `/api/tasks/:id/follow-up` | Send a follow-up message to a task. |
| POST | `/api/tasks/:id/manual-complete` | Promote a stopped or failed task to completed. |
| POST | `/api/tasks/:id/mark-merged` | Mark a task as merged after an external merge. |
| POST, DELETE | `/api/tasks/:id/pending` | Apply a pending message or model override for the next task iteration. |
| PUT, DELETE | `/api/tasks/:id/pending-prompt` | Set the pending prompt used for the next task iteration. |
| GET | `/api/tasks/:id/plan` | Read a task's planning document. |
| POST | `/api/tasks/:id/plan/accept` | Accept a generated task plan. |
| POST | `/api/tasks/:id/plan/discard` | Discard a generated task plan and delete the task. |
| POST | `/api/tasks/:id/plan/feedback` | Submit feedback on a generated task plan. |
| GET | `/api/tasks/:id/pull-request` | Read pull request navigation details for a task. |
| POST | `/api/tasks/:id/pull-request/auto-merge` | Enable pull request auto-merge for a task. |
| POST | `/api/tasks/:id/purge` | Permanently delete a task from storage. |
| POST | `/api/tasks/:id/push` | Push a completed, max-iteration, or locally accepted task branch to the remote repository. |
| GET | `/api/tasks/:id/review-history` | Read review history for a task. |
| GET | `/api/tasks/:id/snapshot` | Read the complete lightweight transcript snapshot for a task. |
| GET, POST | `/api/tasks/:id/terminal-session` | Read or create a task-backed terminal session. |
| GET | `/api/tasks/:id/status-file` | Read a task's status tracking document. |
| POST | `/api/tasks/:id/stop` | Stop an active task run. |
| GET | `/api/tasks/:id/tool-calls/:toolCallId` | Read one complete task tool-call payload. |
| POST | `/api/tasks/:id/update-branch` | Sync a pushed task branch with its base branch. |
| POST | `/api/tasks/title` | Generate a task title from a prompt. |
| GET, PUT | `/api/voice/settings` | Read or update the current user's voice provider settings. |
| POST | `/api/voice/validate` | Validate a configured voice capability against its provider. |
| POST | `/api/voice/transcribe` | Transcribe an uploaded audio recording. |
| POST | `/api/voice/speech` | Generate speech for a response or summary. |
| GET, POST | `/api/workspace-worker-enrollments` | List or create workspace-exclusive Mesh worker enrollments. |
| GET, DELETE | `/api/workspace-worker-enrollments/:id` | Read or cancel a workspace-exclusive Mesh worker enrollment. |
| GET, POST | `/api/workspaces` | List workspaces or create a workspace. |
| GET, PUT, DELETE | `/api/workspaces/:id` | Read, update, or delete a workspace. |
| GET | `/api/workspaces/:id/agents-md` | Read the `AGENTS.md` file and optimization status for a workspace. |
| POST | `/api/workspaces/:id/agents-md/optimize` | Apply `AGENTS.md` optimization changes to a workspace. |
| POST | `/api/workspaces/:id/agents-md/preview` | Preview `AGENTS.md` optimization changes for a workspace. |
| POST | `/api/workspaces/:id/archived-tasks/purge` | Purge archived tasks for a workspace. |
| POST | `/api/workspaces/:id/agents/import` | Import a portable scheduled-agent configuration into a workspace. |
| POST | `/api/workspaces/:id/exec` | Execute one non-interactive command on the workspace's execution host. |
| GET | `/api/workspaces/:id/files` | List workspace files in the active explorer root. |
| GET | `/api/workspaces/:id/files/content` | Read a workspace file. |
| POST | `/api/workspaces/:id/files/delete` | Delete a workspace file or directory in the active explorer root. |
| GET, HEAD | `/api/workspaces/:id/files/download` | Stream a workspace file from the selected execution host. |
| GET | `/api/workspaces/:id/files/metadata` | Read workspace file metadata. |
| GET | `/api/workspaces/:id/files/preview` | Preview a browser-renderable workspace image file. |
| POST | `/api/workspaces/:id/files/rename` | Rename a workspace file or directory in the active explorer root. |
| GET | `/api/workspaces/:id/files/tree` | Load the full workspace file tree. |
| POST | `/api/workspaces/:id/files/upload` | Create a workspace file upload session. |
| POST | `/api/workspaces/:id/files/upload/cancel` | Cancel a workspace file upload session. |
| POST | `/api/workspaces/:id/files/upload/chunk` | Upload a raw chunk for a workspace file upload session. |
| POST | `/api/workspaces/:id/files/upload/complete` | Complete a workspace file upload session. |
| POST | `/api/workspaces/:id/files/write` | Write a workspace file with optional conflict checks. |
| POST | `/api/workspaces/:id/pull-latest-changes` | Pull the latest changes for a workspace's default branch. |
| GET, PUT | `/api/workspaces/:id/server-settings` | Read or update workspace server settings. |
| GET | `/api/workspaces/:id/server-settings/status` | Read the current workspace connection status. |
| POST | `/api/workspaces/:id/server-settings/test` | Test the configured workspace connection using workspace settings. |
| GET | `/api/workspaces/execution-targets` | List local and paired Mesh stdio execution targets. |
| GET | `/api/workspaces/:workspaceId/previews` | List previews associated with a workspace. |
| GET | `/api/execution-hosts/:kind/:id/previews` | List direct previews for a local or Mesh execution host. |

</details>

### Tasks CRUD

#### GET /api/tasks

List all tasks.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|

**Response**

```json
[
  {
    "config": {
      "id": "uuid",
      "name": "My Task",
      "directory": "/path/to/project",
      "prompt": "Implement feature X",
      "createdAt": "2026-01-20T10:00:00.000Z",
      "updatedAt": "2026-01-20T10:00:00.000Z",
      "stopPattern": "<promise>COMPLETE</promise>$",
      "git": {
        "branchPrefix": "",
        "commitScope": ""
      }
    },
    "state": {
      "id": "uuid",
      "status": "idle",
      "currentIteration": 0,
      "recentIterations": []
    }
  }
]
```

#### POST /api/tasks

Create a new task.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Task name shown in the UI. The dashboard can generate a suggested name with `POST /api/tasks/title`, but the final value is submitted by the client. |
| `workspaceId` | string | Yes | ID of the workspace to create the task in |
| `prompt` | string | Yes | Task prompt/PRD (non-empty) |
| `issueNumber` | positive integer | No | GitHub issue number linked to the task; automatic PR descriptions include `Closes #<issueNumber>` |
| `attachments` | array | Yes | Message attachments; use an empty array when there are none |
| `model` | object | Yes | Model selection |
| `model.providerID` | string | Yes | Provider ID (e.g., "anthropic") |
| `model.modelID` | string | Yes | Model ID (e.g., "claude-sonnet-4-20250514") |
| `model.variant` | string | Yes | Model variant (e.g., `"thinking"`); use `""` for the default variant |
| `cheapModel` | object | Yes | Helper-model selection: `{ "mode": "same-as-task" }` or `{ "mode": "custom", "model": { ... } }` |
| `useWorktree` | boolean | Yes | Whether to run the task in a dedicated git worktree |
| `planMode` | boolean | Yes | Start in plan creation mode |
| `maxIterations` | number \| null | Yes | Maximum iterations; use `null` for unlimited |
| `maxConsecutiveErrors` | number | Yes | Maximum consecutive errors before the failsafe stops the task |
| `activityTimeoutSeconds` | number \| null | No | Seconds without events before ending the current turn normally. Use `null` or omit the field for unlimited timeout; finite values must be at least 60 seconds. |
| `stopPattern` | string | Yes | Completion regex. A trailing `<promise>BLOCKED</promise>` always stops safely without completion or automatic push. |
| `git` | object | Yes | Git configuration |
| `git.branchPrefix` | string | Yes | Prefix prepended before the generated `title-hash` branch name; use `""` for no prefix |
| `git.commitScope` | string | Yes | Conventional Commit scope override; use `""` for a scope-less commit |
| `baseBranch` | string | Yes | Base branch to create the task from |
| `clearPlanningFolder` | boolean | Yes | Clear `.clanky-planning` before starting |
| `autoAcceptPlan` | boolean | Yes | Automatically accept a ready plan |
| `fullyAutonomous` | boolean | Yes | Continue through the configured autonomous post-approval flow |
| `draft` | boolean | Yes | Save as draft without starting |
| `uploadedPlan` | object | No | Optional uploaded plan with required `planContent` and optional `statusContent`; cannot be combined with `draft: true` |

**Example Request**

```json
{
  "name": "implement-dark-mode-toggle",
  "workspaceId": "ws-abc123",
  "prompt": "Implement a dark mode toggle in the settings page. Use CSS variables for theming.",
  "issueNumber": 123,
  "attachments": [],
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514",
    "variant": ""
  },
  "cheapModel": { "mode": "same-as-task" },
  "useWorktree": true,
  "planMode": false,
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
}
```

Use `POST /api/tasks/title` if you want Clanky to suggest a name from the prompt before calling this endpoint.

**Response**

Returns the created task object with status `201 Created`.

- If `draft: true`, the task is saved with status `draft` and no git branch is created
- If `planMode: true`, the task starts in `planning` status
- Otherwise, the task starts asynchronously and normally returns with status
  `starting` before transitioning to `running`

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Missing or invalid fields |
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `model_not_enabled` | The selected model is not available or not connected |
| 400 | `provider_not_found` | The specified provider was not found |
| 400 | `model_not_found` | The specified model was not found on the provider |
| 404 | `workspace_not_found` | Workspace not found for the given workspaceId |
| 500 | `start_failed` | Task created but failed to start (normal mode) |
| 500 | `start_plan_failed` | Task created but failed to start plan mode |
| 500 | `create_failed` | Task creation failed |

#### POST /api/tasks/title

Generate a suggested task title from a prompt and workspace context.

**Request Body**

```json
{
  "workspaceId": "ws-abc123",
  "prompt": "Implement JWT-based authentication with login and signup endpoints",
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514",
    "variant": ""
  },
  "cheapModel": { "mode": "same-as-task" }
}
```

**Response**

```json
{
  "title": "implement-jwt-authentication"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 400 | `validation_error` | Missing or invalid request fields |
| 500 | `title_generation_failed` | Failed to generate a title |

#### GET /api/tasks/:id

Get a specific task by ID.

**Response**

Returns the task object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |

#### PATCH /api/tasks/:id

Update a task's configuration. Active execution tasks must be stopped first.
While a task is in planning, only `autoAcceptPlan`, `fullyAutonomous`, and
`isPrivate` may be updated. After plan approval, only `fullyAutonomous` and
`isPrivate` remain mutable while the task is in an editable post-approval
state.

**Request Body**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Update the task name |
| `directory` | string | Update working directory |
| `prompt` | string | Update prompt |
| `issueNumber` | positive integer \| null | Update the linked GitHub issue number; send `null` to clear the existing issue link |
| `model` | object | Update model; `variant` is required when a model is supplied |
| `cheapModel` | object | Update helper-model selection |
| `maxIterations` | number \| null | Update max iterations; `null` means unlimited |
| `maxConsecutiveErrors` | number | Update max consecutive errors |
| `activityTimeoutSeconds` | number \| null | Update activity timeout; inactivity ends the current turn normally (`null` clears it to unlimited) |
| `stopPattern` | string | Update stop pattern |
| `baseBranch` | string | Update base branch |
| `useWorktree` | boolean | Update worktree usage before the task has started |
| `clearPlanningFolder` | boolean | Update clear planning folder flag |
| `planMode` | boolean | Update plan mode flag |
| `autoAcceptPlan` | boolean | Update whether a ready plan is accepted automatically |
| `fullyAutonomous` | boolean | Update the autonomous post-approval flow |
| `isPrivate` | boolean | Update task visibility |
| `git` | object | Update git config with `branchPrefix` and `commitScope` |

**Response**

Returns the updated task object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Invalid fields (e.g., empty name) |
| 400 | `invalid_json` | Request body is not valid JSON |
| 404 | `not_found` | Task not found |
| 409 | `base_branch_immutable` | Cannot change base branch after task has started |
| 409 | `use_worktree_immutable` | Cannot change worktree usage after task has started |
| 500 | `update_failed` | Update operation failed |

#### PUT /api/tasks/:id

Update a draft task's configuration. Only works for tasks in `draft` status.

**Request Body**

Same fields as PATCH.

**Response**

Returns the updated task object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `not_draft` | Only draft tasks can be updated via PUT |
| 400 | `validation_error` | Invalid fields (e.g., empty name) |
| 400 | `invalid_json` | Request body is not valid JSON |
| 404 | `not_found` | Task not found |
| 409 | `base_branch_immutable` | Cannot change base branch after task has started |
| 409 | `use_worktree_immutable` | Cannot change worktree usage after task has started |
| 500 | `update_failed` | Update operation failed |

#### DELETE /api/tasks/:id

Delete a task.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |

---

### Task Control

Tasks are automatically started when created (unless `draft: true`). The following endpoints control task lifecycle after creation.

#### POST /api/tasks/:id/draft/start

Start a draft task. Transitions the task from `draft` status to either `planning`
or `starting`; a non-plan task transitions to `running` after startup.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `planMode` | boolean | Yes | If true, start in plan mode; if false, start immediately |
| `attachments` | array | Yes | Message attachments; use an empty array when there are none |

**Response**

Returns the updated task object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `not_draft` | Task is not in draft status |
| 400 | `validation_error` | Request body must contain planMode boolean |
| 400 | `invalid_json` | Request body is not valid JSON |
| 500 | `start_failed` | Failed to start task (normal mode) |
| 500 | `start_plan_failed` | Failed to start plan mode |

#### POST /api/tasks/:id/accept

Accept a completed or max-iteration task locally without pushing or merging its branch. The task
transitions to `accepted_local`, leaving its commits in the local task branch
and enabling the review/follow-up flow.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `accept_failed` | Cannot accept (e.g., task still running) |

#### POST /api/tasks/:id/push

Push a completed, max-iteration, or locally accepted task's branch to the
remote for PR workflow.

**Response**

When the push succeeds normally:

```json
{
  "success": true,
  "remoteBranch": "origin/add-dark-mode-toggle-a1b2c3d",
  "syncStatus": "clean"
}
```

When the branch is already up to date with the remote:

```json
{
  "success": true,
  "remoteBranch": "origin/add-dark-mode-toggle-a1b2c3d",
  "syncStatus": "already_up_to_date"
}
```

When merge conflicts are detected and being resolved (push deferred):

```json
{
  "success": true,
  "syncStatus": "conflicts_being_resolved"
}
```

Note: When `syncStatus` is `"conflicts_being_resolved"`, the `remoteBranch` field is absent.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `push_failed` | Cannot push (e.g., task still running or no remote) |

#### POST /api/tasks/:id/update-branch

Update a pushed task's branch by syncing it with the latest base branch and re-pushing if possible.

If the sync is clean, the task remains in `pushed` status and the updated branch is pushed immediately. If conflicts are detected, Clanky starts the conflict-resolution flow and auto-pushes when that flow completes.

**Response**

Uses the same response shape as `POST /api/tasks/:id/push`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `update_branch_failed` | Cannot update the pushed branch |

#### POST /api/tasks/:id/discard

Discard a task and delete its git branch.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `discard_failed` | Cannot discard |

#### POST /api/tasks/:id/purge

Permanently delete a draft or archived task from storage. Purge accepts
`draft`, `accepted_local`, `merged`, `pushed`, and `deleted` statuses.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `purge_failed` | Cannot purge (task is not in a purgeable archived state) |

#### GET /api/tasks/:id/terminal-session

Get the terminal session linked to a task.

**Response**

Returns the terminal session object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task or linked terminal session not found |
| 500 | `terminal_session_error` | Failed to read terminal session data |

#### POST /api/tasks/:id/terminal-session

Create or reuse the terminal session linked to a task.

**Response**

Returns the terminal session object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 500 | `terminal_session_error` | Failed to create the terminal session |

#### POST /api/tasks/:id/mark-merged

Mark a pushed task as externally merged and transition it to `merged`.

This is useful when a task branch was merged outside Clanky (for example through a hosted pull-request flow) and you want to synchronize the task state without performing an in-app merge. In worktree-backed flows, branch/worktree cleanup remains part of the normal discard/purge lifecycle.

Only works for tasks in `pushed` or `merged` status.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `mark_merged_failed` | Cannot mark as merged (e.g., task is still running) |

---

### Pending Values

Set or clear pending message and/or model for the next iteration. This is the primary way to interact with running tasks.

#### POST /api/tasks/:id/pending

Set a pending message and/or model for the next iteration. Running tasks use the interrupt-first flow so the pending values are applied on the next iteration.

Works for active tasks (running, waiting, planning, starting) and can also jumpstart tasks in supported stopped states (completed, stopped, failed, max_iterations).

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string \| null | Yes | Message to apply on the next iteration; use `null` when changing only the model |
| `model` | object \| null | Yes | Model change: `{ providerID, modelID, variant }`; use `null` when changing only the message |
| `attachments` | array | Yes | Message attachments; use an empty array when there are none |

At least one of `message` or `model` must be non-null.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Neither message nor model provided, or message is empty |
| 400 | `model_not_enabled` | The selected model is not available |
| 404 | `not_found` | Task not found |
| 409 | `not_running` | Task is not in an active or jumpstart-eligible state |

#### DELETE /api/tasks/:id/pending

Clear all pending values (message and model).

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 409 | `not_running` | Task is not in an active state |

---

### Pending prompt

Modify the prompt for the next iteration while a task is running.

#### PUT /api/tasks/:id/pending-prompt

Set the pending prompt for the next iteration.

**Request Body**

```json
{
  "prompt": "Also update the tests for the feature",
  "attachments": []
}
```

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 409 | `not_running` | Task is not running |
| 400 | `validation_error` | Prompt is empty |

#### DELETE /api/tasks/:id/pending-prompt

Clear the pending prompt.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 409 | `not_running` | Task is not running |

---

### Task Data

#### GET /api/tasks/:id/diff

Get the git diff for a task's changes.

**Response**

```json
[
  {
    "path": "src/components/Button.tsx",
    "status": "modified",
    "additions": 15,
    "deletions": 3,
    "patch": "@@ -1,5 +1,10 @@\n import React from 'react';\n..."
  },
  {
    "path": "src/styles/dark.css",
    "status": "added",
    "additions": 42,
    "deletions": 0,
    "patch": "@@ -0,0 +1,42 @@\n+:root {\n+..."
  }
]
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `no_git_branch` | No git branch was created for this task |
| 400 | `no_worktree` | Task has no worktree path |
| 500 | `diff_failed` | Diff operation failed |

#### GET /api/tasks/:id/plan

Get the contents of `.clanky-planning/plan.md` from the task's worktree directory.

**Response**

```json
{
  "content": "# Project Plan\n\n## Goals\n...",
  "exists": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `no_worktree` | Task has no worktree path |

#### GET /api/tasks/:id/status-file

Get the contents of `.clanky-planning/status.md` from the task's worktree directory.

**Response**

```json
{
  "content": "# Status\n\n## Completed\n...",
  "exists": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `no_worktree` | Task has no worktree path |

#### GET /api/tasks/:id/pull-request

Get pull-request navigation metadata for a task.

Returns an existing GitHub pull-request URL, a compare URL for creating a pull request, or a disabled state when Clanky cannot determine a safe destination.

**Response (existing pull request)**

```json
{
  "enabled": true,
  "destinationType": "existing_pr",
  "url": "https://github.com/example/repo/pull/123"
}
```

**Response (create pull request)**

```json
{
  "enabled": true,
  "destinationType": "create_pr",
  "url": "https://github.com/example/repo/compare/main...feature-branch?expand=1"
}
```

**Response (disabled)**

```json
{
  "enabled": false,
  "destinationType": "disabled",
  "disabledReason": "GitHub CLI is not available in the task environment."
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |

#### GET /api/tasks/:id/comments

Get all review comments for a task.

**Response**

```json
{
  "success": true,
  "comments": [
    {
      "id": "uuid",
      "taskId": "task-uuid",
      "reviewCycle": 1,
      "commentText": "Please fix the error handling in the auth module",
      "createdAt": "2026-01-25T10:00:00.000Z",
      "status": "addressed",
      "addressedAt": "2026-01-25T12:00:00.000Z"
    }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |

---

### Plan Mode

Plan mode allows reviewing and refining a plan before execution begins.

#### POST /api/tasks/:id/plan/feedback

Send feedback to refine the plan during planning phase.

**Request Body**

```json
{
  "feedback": "Please also consider error handling for edge cases",
  "attachments": []
}
```

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 409 | `not_running` | Task is not running or not found |
| 400 | `not_planning` | Task is not in planning status |
| 400 | `validation_error` | Feedback is empty |

#### POST /api/tasks/:id/plan/accept

Accept the plan and either start autonomous execution or open a terminal for the task.

The request body is required and selects the acceptance path.

**Request Body**

```json
{
  "mode": "start_task"
}
```

**Response**

```json
{
  "success": true,
  "mode": "start_task"
}
```

When the accepted plan opens the task terminal:

```json
{
  "success": true,
  "mode": "open_terminal",
  "terminalSession": {
    "config": {
      "id": "terminal-uuid",
      "name": "Task Shell",
      "workspaceId": "ws-abc123",
      "taskId": "abc-123",
      "directory": "/path/to/project",
      "remoteSessionName": "clanky-abc-123",
      "createdAt": "2026-01-20T10:00:00.000Z",
      "updatedAt": "2026-01-20T10:00:00.000Z"
    },
    "state": {
      "status": "ready"
    }
  }
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 409 | `not_running` | Task is not running |
| 400 | `not_planning` | Task is not in planning status |
| 400 | `plan_not_ready` | Plan is not ready yet (still generating) |

#### POST /api/tasks/:id/plan/discard

Discard the plan and delete the task.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |

---

### Review Comments

After a task is pushed or accepted locally, reviewers can submit comments that
the task will address while its review state remains addressable.

#### POST /api/tasks/:id/address-comments

Start addressing reviewer comments. Creates a new review cycle and restarts the task.

**Request Body**

```json
{
  "comments": "Please fix the type errors in the auth module and add unit tests",
  "attachments": []
}
```

**Response**

```json
{
  "success": true,
  "reviewCycle": 1,
  "branch": "add-dark-mode-toggle-a1b2c3d-review-1",
  "commentIds": ["uuid-1", "uuid-2"]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `validation_error` | Comments field is required/empty |
| 409 | `already_running` | Task is already running |

#### GET /api/tasks/:id/review-history

Get the review history for a task, including past review cycles.

**Response**

```json
{
  "success": true,
  "history": {
    "addressable": true,
    "completionAction": "push",
    "reviewCycles": 2,
    "reviewBranches": ["add-dark-mode-toggle-a1b2c3d-review-1", "add-dark-mode-toggle-a1b2c3d-review-2"]
  }
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |

#### POST /api/tasks/:id/follow-up

Resume task execution from a restartable terminal state.

The message is sent as a direct user turn. Completed and pushed tasks reuse
their existing task session when it is still available and continue the normal
task loop. Stopped, failed, and max-iteration tasks restart from their existing
branch when possible. Review comments use the separate
`POST /api/tasks/:id/address-comments` endpoint.

**Request Body**

```json
{
  "message": "Please address the latest review feedback and keep the existing branch history clean.",
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514",
    "variant": ""
  },
  "attachments": []
}
```

The `model` override is optional; when supplied, include `variant` (use `""`
for the default). `attachments` is required and may be an empty array.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Message is empty or invalid |
| 400 | `provider_not_found` | The selected provider does not exist for the workspace |
| 400 | `model_not_found` | The selected model does not exist on the provider |
| 400 | `model_not_enabled` | The selected model provider is not connected |
| 400 | `invalid_state` | The task cannot accept follow-up work in its current state |
| 404 | `not_found` | Task not found |

---

### Models

#### GET /api/models

Get available AI models for a workspace.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |

**Response**

```json
[
  {
    "providerID": "anthropic",
    "providerName": "Anthropic",
    "modelID": "claude-sonnet-4-20250514",
    "modelName": "Claude Sonnet 4",
    "connected": true,
    "variants": ["thinking"]
  },
  {
    "providerID": "openai",
    "providerName": "OpenAI",
    "modelID": "gpt-4o",
    "modelName": "GPT-4o",
    "connected": false
  }
]
```

The `variants` field is optional and only present when the model supports multiple variants.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `models_failed` | Failed to retrieve models |

#### GET /api/models/variants

Get lazily discovered variants for a model in a workspace.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |
| `modelID` | Yes | Model ID |
| `providerID` | No | Ignored; the provider comes from workspace settings |

**Response**

```json
{
  "variants": ["", "thinking"]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 400 | `missing_model_id` | modelID query parameter is required |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `model_variants_failed` | Failed to retrieve model variants |

---

### Preferences

#### GET /api/preferences/last-model

Get the last used model.

**Response**

```json
{
  "providerID": "anthropic",
  "modelID": "claude-sonnet-4-20250514",
  "variant": ""
}
```

Returns `null` if no model has been used.

#### PUT /api/preferences/last-model

Set the last used model.

**Request Body**

```json
{
  "providerID": "anthropic",
  "modelID": "claude-sonnet-4-20250514",
  "variant": ""
}
```

**Response**

```json
{
  "success": true
}
```

#### GET /api/preferences/last-cheap-model

Get the last used helper-model selection.

**Response**

```json
{
  "mode": "same-as-task"
}
```

Returns `null` if no selection has been stored.

#### PUT /api/preferences/last-cheap-model

Set the helper-model selection used by lightweight operations.

**Request Body**

```json
{
  "mode": "custom",
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-haiku-4-20250514",
    "variant": ""
  }
}
```

Use `{ "mode": "same-as-task" }` to reuse the task model.

**Response**

```json
{
  "success": true
}
```

#### GET /api/preferences/last-directory

Get the last used working directory.

**Response**

```json
"/path/to/last/project"
```

Returns `null` if no directory has been used.

#### PUT /api/preferences/last-directory

Set the last used working directory.

**Request Body**

```json
{
  "directory": "/path/to/project"
}
```

**Response**

```json
{
  "success": true
}
```

#### GET /api/preferences/markdown-rendering

Get the markdown rendering preference.

**Response**

```json
{
  "enabled": true
}
```

Defaults to `true` if not set.

#### PUT /api/preferences/markdown-rendering

Set the markdown rendering preference.

**Request Body**

```json
{
  "enabled": false
}
```

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | `enabled` must be a boolean |
| 500 | `save_failed` | Failed to save preference |

#### GET /api/preferences/file-explorer-full-tree

Get whether the file explorer loads the full tree in one request.

**Response**

```json
{
  "enabled": true
}
```

Defaults to `true`.

#### PUT /api/preferences/file-explorer-full-tree

Set full-tree or lazy file-explorer loading.

**Request Body**

```json
{
  "enabled": false
}
```

**Response**

```json
{
  "success": true
}
```

#### GET /api/preferences/dashboard-view-mode

Get the dashboard view mode preference.

**Response**

```json
{
  "mode": "rows"
}
```

Defaults to `"rows"` if not set.

#### PUT /api/preferences/dashboard-view-mode

Set the dashboard view mode preference.

**Request Body**

```json
{
  "mode": "cards"
}
```

Valid modes: `"rows"` or `"cards"`.

**Response**

```json
{
  "success": true,
  "mode": "cards"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Mode must be "rows" or "cards" |
| 500 | `save_failed` | Failed to save preference |

#### GET /api/preferences/quick-chat

Get the saved quick-chat workspace, model, and worktree settings.

**Response**

```json
{
  "workspaceId": "",
  "model": null,
  "useWorktree": false
}
```

These are the defaults when no quick-chat settings have been saved.

#### PUT /api/preferences/quick-chat

Set quick-chat preferences.

**Request Body**

```json
{
  "workspaceId": "ws-abc123",
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514",
    "variant": ""
  },
  "useWorktree": true
}
```

`model` may be `null`. The workspace must exist when `workspaceId` is
non-empty.

**Response**

```json
{
  "success": true,
  "settings": {
    "workspaceId": "ws-abc123",
    "model": {
      "providerID": "anthropic",
      "modelID": "claude-sonnet-4-20250514",
      "variant": ""
    },
    "useWorktree": true
  }
}
```

#### GET /api/preferences/scheduler-timezone

Get the IANA timezone used for scheduled-agent times.

**Response**

```json
{
  "timezone": "UTC"
}
```

Defaults to `UTC`.

#### PUT /api/preferences/scheduler-timezone

Set the scheduler timezone to a valid IANA timezone, such as
`America/Los_Angeles`.

**Request Body**

```json
{
  "timezone": "America/Los_Angeles"
}
```

**Response**

```json
{
  "success": true,
  "timezone": "America/Los_Angeles"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | `timezone` is missing or is not a valid IANA timezone |
| 500 | `save_failed` | Failed to save preference |

---

### Utilities

#### GET /api/check-planning-dir

Check if a workspace has a `.clanky-planning` folder with files.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |

**Response** (directory exists with files)

```json
{
  "exists": true,
  "hasFiles": true,
  "files": ["plan.md", "status.md"]
}
```

**Response** (directory doesn't exist)

```json
{
  "exists": false,
  "hasFiles": false,
  "files": []
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | `workspaceId` query parameter is required |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `check_failed` | Failed to check the planning directory |

---

### Workspaces

Workspaces represent projects managed by Clanky. Each workspace is identified by its ID, has its own server connection settings, and can have multiple tasks. The workspace selects an execution host; its configured directory is the default execution location, not a filesystem sandbox.

#### GET /api/workspaces

List all workspaces.

**Response**

```json
[
  {
    "id": "ws-uuid",
    "name": "My Project",
    "directory": "/path/to/project",
    "workspaceType": "git",
    "allowWorktrees": true,
    "executionTargetRevision": 1,
    "executionHostBinding": {
      "host": {
        "kind": "local",
        "nodeId": "local"
      },
      "targetKey": "local",
      "revision": 1
    },
    "serverSettings": {
      "agent": {
        "provider": "copilot"
      }
    },
    "createdAt": "2026-01-20T10:00:00.000Z",
    "updatedAt": "2026-01-20T10:00:00.000Z"
  }
]
```

#### POST /api/workspaces

Create a new workspace. The directory is validated on the selected execution
host. Git workspaces must point to a repository; directory workspaces may use
any existing directory.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Workspace display name |
| `directory` | string | Yes | Path to the directory on the selected execution host |
| `serverSettings` | object | Yes | Agent provider, for example `{ "agent": { "provider": "copilot" } }` |
| `executionHost` | object | Exactly one of `executionHost`, `sshTarget`, or `workspaceWorkerEnrollmentId` | Registered local, Mesh, or SSH execution-host reference |
| `sshTarget` | object | Exactly one of `executionHost`, `sshTarget`, or `workspaceWorkerEnrollmentId` | Ad hoc SSH target with `host`, `port`, `username`, and optional `password` |
| `workspaceWorkerEnrollmentId` | string | Exactly one of `executionHost`, `sshTarget`, or `workspaceWorkerEnrollmentId` | Dedicated Mesh worker enrollment |
| `workspaceType` | string | No | `git` (default) or `directory` |
| `allowWorktrees` | boolean | No | Whether task, chat, and agent worktrees may be created for this workspace (defaults to `true`) |
| `allowClankyContext` | boolean | No | Whether new execution contexts may receive authenticated Clanky CLI access (defaults to `false`) |

**Response**

Returns the created workspace with status `201 Created`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Missing or invalid fields |
| 400 | `validation_failed` | Failed to validate directory on remote server |
| 400 | `not_git_repo` | Workspace directory is not a git repository |
| 404 | `directory_not_found` | Directory does not exist on the remote server |
| 500 | `create_failed` | Workspace creation failed |

#### GET /api/workspaces/:id

Get a specific workspace by ID.

**Response**

Returns the workspace object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |

#### PUT /api/workspaces/:id

Update a workspace.

**Request Body**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Update display name |
| `serverSettings` | object | Update the agent provider |
| `executionHost` | object | Replace the registered execution host |
| `sshTarget` | object \| null | Replace or clear the ad hoc SSH target |
| `isPrivate` | boolean | Hide the workspace when private items are hidden |
| `archived` | boolean | Hide the workspace from active work surfaces |
| `allowClankyContext` | boolean | Allow authenticated Clanky CLI access in new execution contexts |
| `allowWorktrees` | boolean | Enable or disable creation of task, chat, and agent worktrees |

**Response**

Returns the updated workspace.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `update_failed` | Update operation failed |

#### DELETE /api/workspaces/:id

Delete a workspace.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 400 | `delete_failed` | Cannot delete workspace |

#### POST /api/workspaces/:id/exec

Execute one non-interactive command on the host selected by the workspace.
The workspace selects the execution host; it is not a filesystem sandbox.
Commands are invoked with an executable and a separate argument array, without
an implicit shell or environment override.

**Request Body**

```json
{
  "command": "git",
  "args": ["status", "--short"],
  "cwd": "packages/api",
  "timeoutMs": 120000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | Yes | Executable name or path. It is never concatenated into a shell command. |
| `args` | string[] | No | Arguments passed as-is, defaulting to an empty array. |
| `cwd` | string | No | Relative to `workspace.directory`, or an absolute path on the selected host. |
| `timeoutMs` | integer | No | Positive timeout in milliseconds, up to 30 minutes. |

Use an explicit shell command such as `sh -c` when shell syntax is required.
An omitted `cwd` uses the workspace directory. The selected host validates
that the resolved working directory exists.

**Response**

Commands that complete, including commands with a non-zero exit code, return
HTTP `200` with their captured output:

```json
{
  "workspaceId": "ws-abc123",
  "success": false,
  "stdout": "",
  "stderr": "working tree has changes\n",
  "exitCode": 1
}
```

`success` is true only when the process exits with code `0`. `stdout` and
`stderr` are captured independently. Each stream is limited to 8 MiB; the
command is terminated when either limit is exceeded. To handle output larger
than 8 MiB, redirect it to a file on the execution host and use the download
operation below.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Request body is invalid. |
| 400 | `workspace_exec_cwd_invalid` | The working directory is empty or invalid. |
| 400 | `workspace_exec_cwd_not_found` | The working directory does not exist on the selected host. |
| 401 | — | Authentication is required. |
| 404 | `workspace_not_found` | Workspace not found or not owned by the caller. |
| 413 | `workspace_exec_output_limit_exceeded` | stdout or stderr exceeded 8 MiB. |
| 499 | `mesh_execution_aborted` | The request or remote execution was cancelled. |
| 502 | `mesh_execution_unreachable` | The selected execution host is unavailable. |
| 500 | `workspace_exec_failed` | Unexpected command execution failure. |

#### GET, HEAD /api/workspaces/:id/files/download

Stream a regular file from the host selected by the workspace. The route
accepts a URL-encoded `path` query parameter:

```text
GET /api/workspaces/ws-abc123/files/download?path=%2Ftmp%2Fapp.tar.gz
```

Relative paths resolve from `workspace.directory`; absolute paths are used
directly on the selected host. There is no application-level file-size limit,
so this route can retrieve files larger than the 8 MiB command-output limit.
The response is binary and streamed; it is not a JSON API response.
Directories return `invalid_path_type`. `HEAD` returns the
same file metadata without transferring bytes.

The response includes `Content-Disposition`, `Content-Type`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and the
authoritative `X-Clanky-Download-Size` metadata header. `HEAD` responses also
include `Content-Length`. A streamed `GET` may use chunked transfer without a
`Content-Length` header when the selected host is reached through Mesh or
another remote stream; clients that need the size should use
`X-Clanky-Download-Size`. Request cancellation aborts an in-progress remote
stream. The other file-explorer operations (listing, reading, writing,
renaming, and deleting) retain their active-root containment rules.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_workspace_path` | The requested path is invalid for the file operation. |
| 400 | `invalid_path_type` | The requested path is a directory rather than a regular file. |
| 404 | `workspace_not_found` | Workspace not found or not owned by the caller. |
| 404 | `file_not_found` | The requested file does not exist on the selected host. |
| 500 | `workspace_file_error` | File download failed. |

#### POST /api/workspaces/:id/files/upload

Create a streamed upload session for a regular file on the host selected by the
workspace. The upload is finalized atomically only after all declared bytes
have been received. The selected host may be local, SSH, or a Mesh execution
peer.

**Request Body**

```json
{
  "directory": "dist",
  "fileName": "app.tar.gz",
  "size": 12582912,
  "overwrite": false,
  "startDirectory": null
}
```

`directory` is relative to `startDirectory` (or `workspace.directory` when it
is omitted), and `fileName` must be a single file name. As with downloads and
execution, an absolute `startDirectory` is used directly on the selected host;
the workspace directory is not a filesystem sandbox. The destination directory
must already exist.

The response is `201` with an `uploadId`. Send the file body in one or more
raw binary requests:

```text
POST /api/workspaces/ws-abc123/files/upload/chunk?uploadId=<UPLOAD_ID>&offset=0
Content-Type: application/octet-stream
```

`offset` must equal the number of bytes already accepted. The server enforces
the declared `size` against the bytes actually consumed from the request body;
it does not rely on `Content-Length`. A chunk that exceeds the remaining size
returns `413 upload_size_exceeded` and does not write beyond the declared
file size. Clients may retry a failed chunk from its original offset.

Complete the upload after the response's `nextOffset` reaches `size`:

```json
POST /api/workspaces/ws-abc123/files/upload/complete

{ "uploadId": "<UPLOAD_ID>" }
```

Use `POST /api/workspaces/:id/files/upload/cancel` with the upload ID to remove
an abandoned temporary upload. The browser and CLI clients use replayable
8 MiB chunks with up to three attempts; 8 MiB is a chunking default, not a
total file-size limit. Mesh forwards each chunk as a binary stream, so uploads
larger than the mesh JSON result limit are supported.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Upload metadata or chunk parameters are invalid. |
| 404 | `workspace_not_found` | Workspace not found or not owned by the caller. |
| 409 | `file_conflict` | The destination exists and overwrite was not requested. |
| 413 | `upload_size_exceeded` | The request body exceeds the remaining declared upload size. |
| 500 | `workspace_file_error` | Upload, completion, or cancellation failed. |

#### POST /api/workspaces/:id/archived-tasks/purge

Purge all archived tasks for a workspace.

Only tasks matching the archived-task predicate for the target workspace are processed. Archived tasks are deleted tasks, plus merged, pushed, or accepted-local tasks that are no longer awaiting feedback. Pushed or accepted-local tasks that remain addressable for reviewer feedback are not purged. The response includes both successful purges and per-task failures.

**Response**

```json
{
  "success": true,
  "workspaceId": "ws-abc123",
  "totalArchived": 3,
  "purgedCount": 2,
  "purgedTaskIds": ["task-1", "task-2"],
  "failures": [
    {
      "taskId": "task-3",
      "error": "Cannot purge task in current state"
    }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `purge_archived_failed` | Failed to purge archived tasks for the workspace |

---

### AGENTS.md Optimization

Manage the workspace's `AGENTS.md` file, which provides AI coding agent guidelines. Clanky can append an optimization section to improve agent performance with Clanky Tasks.

#### GET /api/workspaces/:id/agents-md

Get the current AGENTS.md content and optimization status for a workspace.

**Response**

```json
{
  "content": "# AGENTS.md - AI Coding Agent Guidelines\n...",
  "fileExists": true,
  "analysis": {
    "isOptimized": true,
    "currentVersion": 1,
    "updateAvailable": false
  }
}
```

| Field | Description |
|-------|-------------|
| `content` | File contents (empty string if file doesn't exist) |
| `fileExists` | Whether the AGENTS.md file exists in the workspace |
| `analysis.isOptimized` | Whether the file already has a Clanky optimization section |
| `analysis.currentVersion` | Version of the existing optimization, or `null` |
| `analysis.updateAvailable` | Whether a newer optimization version is available |

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `read_failed` | Failed to read AGENTS.md |

#### POST /api/workspaces/:id/agents-md/preview

Preview what the optimized AGENTS.md would look like without writing changes.

**Response**

```json
{
  "currentContent": "# AGENTS.md\n...",
  "proposedContent": "# AGENTS.md\n...\n## Agentic Workflow...",
  "analysis": {
    "isOptimized": false,
    "currentVersion": null,
    "updateAvailable": true
  },
  "fileExists": true,
  "clankySection": "## Agentic Workflow — Planning & Progress Tracking\n..."
}
```

| Field | Description |
|-------|-------------|
| `currentContent` | Current file contents (empty string if not found) |
| `proposedContent` | What the file would look like after optimization |
| `analysis` | Current optimization state |
| `fileExists` | Whether the file currently exists |
| `clankySection` | The Clanky section that would be added or updated |

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `read_failed` | Failed to read AGENTS.md |
| 500 | `preview_failed` | Failed to generate preview |

#### POST /api/workspaces/:id/agents-md/optimize

Apply the Clanky optimization to the workspace's AGENTS.md file. If the file already has an optimization section at the current version, returns without changes.

**Response (optimization applied)**

```json
{
  "success": true,
  "alreadyOptimized": false,
  "content": "# AGENTS.md\n...\n## Agentic Workflow...",
  "analysis": {
    "isOptimized": true,
    "currentVersion": 1,
    "updateAvailable": false
  }
}
```

**Response (already optimized)**

```json
{
  "success": true,
  "alreadyOptimized": true,
  "content": "# AGENTS.md\n...",
  "analysis": {
    "isOptimized": true,
    "currentVersion": 1,
    "updateAvailable": false
  }
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `read_failed` | Failed to read AGENTS.md |
| 500 | `write_failed` | Failed to write optimized AGENTS.md |
| 500 | `optimize_failed` | Failed to optimize AGENTS.md |

---

### Server Settings

Server settings select the agent provider for a workspace. The execution host
is configured separately on the workspace through `executionHost`, `sshTarget`,
or `workspaceWorkerEnrollmentId`.

```json
{
  "agent": {
    "provider": "opencode"
  }
}
```

Supported providers are `opencode`, `copilot`, `codex`, `claude`, `pi`, and
`grok`.

#### GET /api/workspaces/:id/server-settings

Get server settings for a specific workspace.

**Response**

```json
{
  "agent": {
    "provider": "opencode"
  }
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Workspace not found |

#### PUT /api/workspaces/:id/server-settings

Update server settings for a workspace.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent.provider` | string | Yes | `opencode`, `copilot`, `codex`, `claude`, `pi`, or `grok` |

**Response**

```json
{
  "agent": {
    "provider": "copilot"
  }
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Invalid settings payload |
| 404 | `workspace_not_found` | Workspace not found |

#### GET /api/workspaces/:id/server-settings/status

Get connection status for a workspace.

**Response**

```json
{
  "connected": true,
  "provider": "opencode",
  "transport": "mesh",
  "capabilities": ["createSession", "sendPromptAsync", "abortSession", "subscribeToEvents", "models"],
  "directoryExists": true,
  "isGitRepo": true,
  "executionAvailability": "remote-connected"
}
```

`transport` identifies the selected execution-host kind: `local`, `mesh`, or
`ssh`. `serverUrl` is included only when the active agent runtime exposes one.
`executionAvailability` describes whether a remote Mesh host is reachable.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |

#### POST /api/workspaces/:id/server-settings/test

Test the current workspace connection, or test a proposed provider.

**Request Body**

Pass `{}` or no body to use the workspace's current settings. To test a
different provider, send a server-settings object:

```json
{
  "agent": {
    "provider": "codex"
  }
}
```

**Response**

```json
{
  "success": true,
  "message": "Connection successful"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `validation_error` | Proposed settings do not match schema |
| 404 | `workspace_not_found` | Workspace not found |

#### POST /api/server-settings/test

Test a server connection before creating a workspace.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `settings` | object | Yes | Server settings to test |
| `settings.agent.provider` | string | Yes | `opencode`, `copilot`, `codex`, `claude`, `pi`, or `grok` |
| `directory` | string | Yes | Directory path to test against |
| `executionHost` | object | Exactly one of `executionHost`, `sshTarget`, or `workspaceWorkerEnrollmentId` | Registered execution-host reference |
| `sshTarget` | object | Exactly one of `executionHost`, `sshTarget`, or `workspaceWorkerEnrollmentId` | Ad hoc SSH target |
| `workspaceWorkerEnrollmentId` | string | Exactly one of `executionHost`, `sshTarget`, or `workspaceWorkerEnrollmentId` | Dedicated Mesh worker enrollment |

**Response**

```json
{
  "success": true,
  "message": "Connection successful"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Missing or invalid fields |
| 500 | — | Connection test failed (returns `{ success: false, error: "..." }`) |

#### POST /api/settings/reset-all

Delete the database and reinitialize it. This destructive operation deletes all
tasks, workspaces, sessions, and preferences before recreating the current
schema.

**Response**

```json
{
  "success": true,
  "message": "All settings have been reset. Database recreated."
}
```

#### POST /api/settings/purge-terminal-tasks

Permanently delete archived terminal tasks across every workspace. This is a destructive operation that deletes task data only; workspaces, sessions, and preferences are preserved.

The endpoint uses the same archived-task predicate as the workspace purge endpoint: deleted tasks are purged, and merged, pushed, or accepted-local tasks are purged only when they are no longer awaiting feedback. Pushed or accepted-local tasks that remain addressable for reviewer feedback are not purged, so not every pushed task is deleted.

**Response**

```json
{
  "success": true,
  "totalWorkspaces": 2,
  "totalArchived": 3,
  "purgedCount": 2,
  "purgedTaskIds": ["task-1", "task-2"],
  "failures": [
    { "workspaceId": "workspace-2", "taskId": "task-3", "error": "permission denied" }
  ],
  "workspaces": [
    {
      "workspaceId": "workspace-1",
      "totalArchived": 2,
      "purgedCount": 2,
      "purgedTaskIds": ["task-1", "task-2"],
      "failures": []
    }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 500 | `purge_terminal_tasks_failed` | Failed to purge terminal-state tasks |

---

### Terminal Sessions

Terminal sessions are persistent sessions backed by a workspace or a direct
execution host. They can use local, Mesh, or SSH transports.

#### GET /api/terminal-sessions

List terminal sessions. Optionally filter to one workspace.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | No | Restrict results to one workspace |

**Response**

Returns an array of terminal session objects.

#### POST /api/terminal-sessions

Create a persistent terminal session for a workspace or direct execution host.
Provide exactly one of `workspaceId` or `executionHost`. Direct execution-host
sessions also require `directory`.

**Request Body**

```json
{
  "workspaceId": "ws-abc123",
  "name": "Debug Shell",
  "connectionMode": "dtach",
  "useTmux": false
}
```

For a direct execution host, replace `workspaceId` with an execution-host
reference and include the working directory:

```json
{
  "executionHost": { "kind": "mesh", "nodeId": "worker-1" },
  "directory": "/workspaces/project",
  "name": "Worker Shell",
  "connectionMode": "direct",
  "useTmux": false
}
```

**Response**

Returns the created terminal session object with status `201 Created`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_session_configuration` | The workspace cannot open a persistent terminal session with its current setup |
| 400 | `validation_error` | Missing or invalid request fields |
| 404 | `not_found` | Workspace not found |
| 500 | `terminal_session_error` | Failed to create the session |

#### GET /api/terminal-sessions/:id

Get one terminal session.

#### PATCH /api/terminal-sessions/:id

Rename a terminal session.

**Request Body**

```json
{
  "name": "Renamed Shell"
}
```

#### DELETE /api/terminal-sessions/:id

Delete a terminal session.

**Response**

```json
{
  "success": true
}
```

---

### Standalone SSH Servers

Standalone SSH servers let the browser register reusable SSH targets and
exchange encrypted credentials. Registered SSH servers are execution-host
sources; use the `/api/execution-hosts/ssh/:id/...` routes for commands,
working-directory resolution, file operations, provider/model discovery,
prerequisite checks, Devbox templates, and direct chats.

#### GET /api/ssh-servers

List registered standalone SSH servers.

#### POST /api/ssh-servers

Create a standalone SSH server entry.

**Request Body**

```json
{
  "name": "Build Box",
  "address": "build.example.com",
  "username": "vscode",
  "repositoriesBasePath": null
}
```

**Response**

Returns the created SSH server object with status `201 Created`.

#### GET /api/ssh-servers/:id

Get one standalone SSH server.

#### PATCH /api/ssh-servers/:id

Update a standalone SSH server.

**Request Body**

Provide one or more of `name`, `address`, `username`, `repositoriesBasePath`,
or `isPrivate`.

#### DELETE /api/ssh-servers/:id

Delete a standalone SSH server.

**Response**

```json
{
  "success": true
}
```

#### GET /api/ssh-servers/:id/public-key

Fetch the server public key metadata used by the browser to encrypt credentials locally before upload.

**Response**

```json
{
  "algorithm": "RSA-OAEP-256",
  "publicKey": "-----BEGIN PUBLIC KEY-----...",
  "fingerprint": "sha256:...",
  "version": 1,
  "createdAt": "2026-01-20T10:00:00.000Z"
}
```

#### POST /api/ssh-servers/:id/credentials

Exchange an encrypted credential payload for a short-lived credential token.

**Request Body**

```json
{
  "encryptedCredential": {
    "algorithm": "RSA-OAEP-256",
    "fingerprint": "sha256:...",
    "version": 1,
    "ciphertext": "base64-encoded-ciphertext"
  }
}
```

**Response**

```json
{
  "credentialToken": "token-uuid",
  "expiresAt": "2026-01-20T10:05:00.000Z"
}
```

Pass the short-lived credential token in the
`x-clanky-ssh-credential-token` header when an SSH execution-host operation
requires it. Use `/api/terminal-sessions` to create an interactive session
backed by the SSH execution host.

---

### Provisioning

Provisioning jobs create or reuse a remote workspace by cloning a repository
onto a selected execution host, preparing the environment, and creating the
resulting workspace in Clanky. New automatic workspaces use a dedicated HTTPS
Mesh worker by default; SSH remains available by setting `transport` to
`"ssh"`.

#### POST /api/provisioning-jobs

Create a provisioning job.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Provisioning job name |
| `executionHost` | object | Exactly one of `executionHost` or `workspaceWorkerEnrollmentId` | Execution host reference, such as `{ "kind": "local", "nodeId": "..." }` or `{ "kind": "ssh", "serverId": "..." }` |
| `workspaceWorkerEnrollmentId` | string | Exactly one of `executionHost` or `workspaceWorkerEnrollmentId` | Existing dedicated worker enrollment; only valid for `provision` mode |
| `transport` | string | No | `worker` (default for new automatic workspaces) or `ssh` |
| `workerEnrollmentRoute` | string | No | `direct` or `relay` for a new worker transport; when omitted, the controller selects its configured default |
| `workerHostAddress` | string \| null | Required for direct worker `provision`; omit for relay workers | Reachable IPv4 address or hostname without spaces |
| `workerHostAddressManual` | boolean | No | Set to `true` when using a manually entered host instead of a discovered IPv4 address |
| `repoUrl` | string | Yes | Repository URL for `provision` mode unless `createNewRepository` is true |
| `basePath` | string | Yes | Parent path used by `provision` mode |
| `devcontainerSubpath` | string \| null | Yes | Optional devcontainer subpath; use `null` when absent |
| `devboxTemplate` | string \| null | No | Devbox template when creating a new repository |
| `githubUser` | string \| null | No | Optional GitHub user passed to devbox |
| `provider` | string | Yes | `opencode`, `copilot`, `codex`, `claude`, `pi`, or `grok` |
| `credentialToken` | string \| null | Yes | Exchanged SSH credential token; use `null` when the server needs no credential |
| `mode` | string | Yes | `provision`, `rebuild`, `restart`, or `arise` |
| `createNewRepository` | boolean | No | Create a new repository with a devbox template; defaults to `false` |
| `targetDirectory` | string \| null | Yes | Existing repository path for `rebuild` or `restart`; use `null` otherwise |
| `workspaceId` | string \| null | Yes | Existing workspace ID for `rebuild` or `restart`; use `null` otherwise |

```json
{
  "name": "clanky-demo",
  "executionHost": {
    "kind": "local",
    "nodeId": "execution-host-node-uuid"
  },
  "transport": "worker",
  "workerEnrollmentRoute": "direct",
  "workerHostAddress": "worker.example.com",
  "workerHostAddressManual": true,
  "repoUrl": "https://github.com/example/repo.git",
  "basePath": "/workspaces",
  "devcontainerSubpath": null,
  "provider": "copilot",
  "credentialToken": "token-uuid",
  "mode": "provision",
  "createNewRepository": false,
  "targetDirectory": null,
  "workspaceId": null
}
```

`provider` accepts `"copilot"`, `"opencode"`, `"codex"`, `"claude"`, `"pi"`, or
`"grok"`. Set `workerEnrollmentRoute` to `"relay"` to create a relay-only
worker and omit `workerHostAddress`; set it to `"direct"` to require a
reachable worker address. If the route is omitted, the controller preserves
the existing default selection based on its relay pairing. For direct worker
provisioning, a discovered address must be one of the addresses returned by
the selected execution host. Set `workerHostAddressManual` to `true` for a
manually entered host value. The controller must have
`CLANKY_PUBLIC_BASE_URL` configured. For `rebuild` and `restart`, provide
`targetDirectory` and `workspaceId`; `arise` only needs the server context and
mode-specific fields may be `null`.

**Response**

Returns the created provisioning job snapshot with status `201 Created`.

```json
{
  "job": {
    "config": {
      "id": "prov-uuid",
      "name": "clanky-demo",
      "executionHostBinding": {
        "host": {
          "kind": "local",
          "nodeId": "execution-host-node-uuid"
        },
        "targetKey": "local:execution-host-node-uuid",
        "revision": 1
      },
      "transport": "worker",
      "workerEnrollmentRoute": "direct",
      "workerHostAddress": "192.0.2.10",
      "repoUrl": "https://github.com/example/repo.git",
      "basePath": "/workspaces",
      "provider": "copilot",
      "createdAt": "2026-01-20T10:00:00.000Z"
    },
    "state": {
      "status": "pending",
      "updatedAt": "2026-01-20T10:00:00.000Z"
    }
  },
  "logs": []
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Missing or invalid request fields |
| 400 | `invalid_credential_token` | Credential token is missing, expired, or invalid for the target SSH server |
| 404 | `not_found` | SSH server not found |
| 500 | `provisioning_error` | Failed to start provisioning |

#### GET /api/provisioning-jobs/:id

Get the current provisioning job snapshot.

**Response**

Returns the provisioning job snapshot, including `job`, `logs`, and `workspace` when a workspace has already been created or reused.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Provisioning job not found |
| 500 | `provisioning_error` | Failed to read provisioning job state |

#### DELETE /api/provisioning-jobs/:id

Cancel a provisioning job.

**Response**

```json
{
  "success": true,
  "job": {
    "config": {
      "id": "prov-uuid"
    },
    "state": {
      "status": "cancelled"
    }
  }
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Provisioning job not found |
| 500 | `provisioning_error` | Failed to cancel the provisioning job |

#### GET /api/provisioning-jobs/:id/logs

Get the collected log entries for a provisioning job.

**Response**

```json
{
  "success": true,
  "logs": [
    {
      "id": "log-1",
      "source": "system",
      "text": "Cloning repository...",
      "timestamp": "2026-01-20T10:00:01.000Z",
      "step": "clone_repo"
    }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Provisioning job not found |
| 500 | `provisioning_error` | Failed to read provisioning logs |

---

### Git

#### GET /api/git/branches

Get all local branches for a workspace.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |

**Response**

```json
{
  "currentBranch": "main",
  "branches": [
    { "name": "main", "current": true },
    { "name": "feature/auth", "current": false },
    { "name": "add-tests-1a2b3c4", "current": false }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 400 | `not_git_repo` | Workspace directory is not a git repository |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `git_error` | Failed to retrieve branches |

#### GET /api/git/default-branch

Get the default branch for a workspace's git repository (e.g., "main" or "master").

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |

**Response**

```json
{
  "defaultBranch": "main"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 400 | `not_git_repo` | Workspace directory is not a git repository |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `git_error` | Failed to retrieve default branch |

#### GET /api/git/remote-status

Check whether a named git remote is configured for a workspace. The `remote`
query parameter defaults to `origin`.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |
| `remote` | No | Remote name; defaults to `origin` |

**Response**

```json
{
  "remote": "origin",
  "hasRemote": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 400 | `not_git_repo` | Workspace directory is not a git repository |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `git_error` | Failed to determine remote status |

#### GET /api/git/github-repository-url

Resolve the normalized GitHub repository URL for a workspace. An explicitly
configured workspace repository URL is preferred; otherwise the URL is read
from the `origin` remote. Non-GitHub repositories return `null`.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |

**Response**

```json
{
  "githubUrl": "https://github.com/example/project"
}
```

`githubUrl` is `null` when no GitHub repository URL can be resolved.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `git_error` | Failed to determine the GitHub repository URL |

#### GET /api/git/github-issues

List open GitHub issues for the workspace repository using the repository's
GitHub URL and configured GitHub CLI credentials.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | Yes | Workspace ID |

**Response**

```json
{
  "issues": [
    { "number": 42, "title": "Improve task output" }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 400 | `not_git_repo` | Workspace directory is not a git repository |
| 404 | `workspace_not_found` | Workspace not found |
| 502 | `github_issues_unavailable` | GitHub issues could not be fetched for this workspace |
| 502 | `github_issues_invalid_response` | GitHub returned an invalid issues response |
| 500 | `github_issues_error` | Failed to list GitHub issues |

---

### Events (WebSocket)

#### WS /api/ws

Authenticated framework realtime endpoint for private resource invalidations and selected
incremental task, chat, agent-run, and provisioning events. The endpoint is protected by
the framework's same-origin policy.

**Query Parameters**

Every query parameter is copied into an exact-match publication filter. Multiple
parameters are combined with AND. Common filters are:

| Parameter | Description |
|-----------|-------------|
| `resource` | Resource name for invalidation events, such as `tasks`, `chats`, `agents`, `agent-runs`, `terminal-sessions`, `provisioning-jobs`, `previews`, `mesh`, or `execution-hosts` |
| `id` | Entity ID for a resource invalidation |
| `scope` | Resource scope, such as an agent ID for `agent-runs`, a workspace ID for workspace `previews`, or a serialized execution-host reference (for example, `local:node-id` or `mesh:node-id`) for direct server `previews` |
| `taskId` | Target a retained task stream |
| `chatId` | Target a retained chat stream |
| `agentId` | Target a retained agent-run stream or an agent-run resource scope |
| `agentRunId` | Target a retained agent-run stream |
| `provisioningJobId` | Target a retained provisioning stream |

For example, `?taskId=abc` selects retained task events, while
`?resource=tasks&id=abc` selects task resource invalidations. Use no filter when
both kinds of event are needed.

**Connection URL Examples**

```
ws://localhost:3000/api/ws              # All events
ws://localhost:3000/api/ws?taskId=abc   # Retained events for task "abc"
ws://localhost:3000/api/ws?resource=tasks&id=abc # Task invalidations for "abc"
wss://example.com/api/ws                # Secure WebSocket
```

**CLI bridge example**

```bash
# Connect using the selected profile and stream JSON frames
clanky ws

# Select another configured destination
clanky --profile production ws
```

`clanky ws` uses the selected framework profile or environment credentials. The command upgrades a websocket connection to `/api/ws`, prints each incoming text frame to stdout unchanged, accepts one JSON value per non-empty stdin line, and exits non-zero on invalid stdin, auth/connection failures, or abnormal websocket termination. It intentionally does not accept Clanky-specific filters or a positional base URL.

**Event Types**

Published events are wrapped in a framework envelope:

```json
{
  "type": "event",
  "event": {
    "type": "tasks.changed",
    "resource": "tasks",
    "action": "changed",
    "id": "abc-123"
  }
}
```

Resource invalidations use these resource names and actions:

| Event type | Description |
|------------|-------------|
| `tasks.changed`, `tasks.deleted` | Task collection or entity changed/deleted |
| `chats.changed`, `chats.deleted` | Chat collection or entity changed/deleted |
| `agents.changed`, `agents.deleted` | Agent collection or entity changed/deleted |
| `agent-runs.changed`, `agent-runs.deleted` | Agent-run collection or entity changed/deleted |
| `terminal-sessions.changed`, `terminal-sessions.deleted` | Workspace terminal collection or entity changed/deleted |
| `provisioning-jobs.changed`, `provisioning-jobs.deleted` | Provisioning-job collection or entity changed/deleted |
| `previews.changed`, `previews.deleted` | Preview collection or entity changed/deleted |
| `mesh.changed`, `mesh.deleted` | Mesh controller or worker state changed/deleted |
| `execution-hosts.changed`, `execution-hosts.deleted` | Execution-host collection or entity changed/deleted |

Selected incremental events are sent as the nested `event` value. The retained
event types are:

| Area | Event types |
|------|-------------|
| Tasks | `task.message`, `task.message.delta`, `task.tool_call`, `task.log`, `task.log.delta`, `task.iteration.start`, `task.iteration.end`, `task.git.commit` |
| Chats | `chat.status` (terminal statuses), `chat.message`, `chat.message.delta`, `chat.tool_call`, `chat.log`, `chat.log.delta` |
| Agent runs | `agent.run.message`, `agent.run.message.delta`, `agent.run.tool_call`, `agent.run.log`, `agent.run.log.delta` |
| Provisioning | `provisioning.step`, `provisioning.output` |

Other domain lifecycle notifications, including `task.accepted`, `task.merged`,
`task.pushed`, and `task.discarded`, cause a resource invalidation rather than
being sent with their domain event name.

**Keep-Alive**

Send a JSON ping message to receive a pong response:

```
// Client sends:
{"type":"ping"}

// Server responds:
{"type":"pong"}
```

**Example Events**

```json
{"type":"event","event":{"type":"task.iteration.start","taskId":"abc-123","iteration":3,"timestamp":"2026-01-20T10:15:00.000Z"}}

{"type":"event","event":{"type":"task.log","taskId":"abc-123","id":"log-1","level":"info","message":"Sending prompt to AI","timestamp":"2026-01-20T10:15:01.000Z"}}
```

**JavaScript Example**

```javascript
const ws = new WebSocket('ws://localhost:3000/api/ws');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type !== 'event' || !data.event) {
    return;
  }
  console.log('Event:', data.event.type, data.event);
};

ws.onclose = () => {
  console.log('Disconnected');
  // Implement reconnection logic as needed
};
```

#### WS /api/terminal

WebSocket endpoint for an interactive terminal session.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `terminalSessionId` | Required | Connect to a terminal session created through `/api/terminal-sessions` |

An SSH-backed terminal session that is not attached to a workspace requires an
initial credential message after the socket opens:

```json
{
  "type": "terminal.auth",
  "credentialToken": "token-uuid"
}
```

The terminal socket emits events such as `terminal.connected`,
`terminal.output`, `terminal.clipboard`, `terminal.error`, and
`terminal.closed`.

---

## Data Types

### Task Status

| Status | Description |
|--------|-------------|
| `idle` | Created but not started |
| `draft` | Saved as draft, not started (no git branch or session) |
| `planning` | In plan mode, awaiting plan approval |
| `starting` | Initializing backend connection |
| `running` | Actively executing |
| `waiting` | Between iterations |
| `completed` | Stop pattern matched |
| `stopped` | Manually stopped |
| `failed` | Error occurred |
| `max_iterations` | Hit iteration limit |
| `resolving_conflicts` | Resolving merge conflicts with base branch before push |
| `accepted_local` | Changes accepted while keeping commits on the local task branch |
| `merged` | Changes merged into original branch |
| `pushed` | Branch pushed to remote (can receive reviews) |
| `deleted` | Soft-deleted and normally hidden from active task views |

### File Diff Status

| Status | Description |
|--------|-------------|
| `added` | New file |
| `modified` | File changed |
| `deleted` | File removed |
| `renamed` | File renamed |

### Log Levels

Log levels used in `task.log` events:

| Level | Description |
|-------|-------------|
| `agent` | AI agent activity |
| `user` | User-initiated actions |
| `info` | General information |
| `warn` | Warning messages |
| `error` | Error messages |
| `debug` | Debug/verbose output |
| `trace` | Detailed trace output |

### Review Comment Status

| Status | Description |
|--------|-------------|
| `pending` | Comment is being worked on |
| `addressed` | Comment has been addressed |

### Iteration Outcome

| Outcome | Description |
|---------|-------------|
| `continue` | Iteration complete, task continues |
| `complete` | Stop pattern matched, task complete |
| `error` | Error occurred during iteration |
| `plan_ready` | Plan created and ready for review (planning mode) |

### Commit Message Format

Clanky generates commit messages following the
[Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type: description
type(scope): description
```

Clanky defaults to scope-less commit messages. When `git.commitScope` is set, it should name a meaningful module, section, or topic touched by the change. Generic placeholder values such as `"clanky"` are omitted. Valid types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`, `perf`, `revert`.

Examples:
- `feat: add JWT authentication endpoint`
- `fix(auth): handle token expiration edge case`
- `chore(api): update task creation request docs`

### TODO Item

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `content` | string | TODO item description |
| `status` | string | "pending", "in_progress", "completed", or "cancelled" |
| `priority` | string | "high", "medium", or "low" |

---

## Examples

### Create a Task

Tasks are automatically started upon creation (unless `draft: true`).

```bash
# Create a task (starts automatically)
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "implement-jwt-authentication",
    "workspaceId": "ws-abc123",
    "prompt": "Implement JWT-based authentication with login and signup endpoints",
    "attachments": [],
    "model": {
      "providerID": "anthropic",
      "modelID": "claude-sonnet-4-20250514",
      "variant": ""
    },
    "cheapModel": { "mode": "same-as-task" },
    "useWorktree": true,
    "planMode": false,
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

# Response: {"config":{"id":"abc-123",...},"state":{"status":"starting",...}}

# Watch events via WebSocket (use wscat or similar)
wscat -c ws://localhost:3000/api/ws?taskId=abc-123
```

### Create a Draft Task

Draft tasks are saved without starting. You can edit them before starting.

```bash
# Create a draft task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "implement-jwt-authentication",
    "workspaceId": "ws-abc123",
    "prompt": "Implement JWT-based authentication",
    "attachments": [],
    "model": {
      "providerID": "anthropic",
      "modelID": "claude-sonnet-4-20250514",
      "variant": ""
    },
    "cheapModel": { "mode": "same-as-task" },
    "useWorktree": true,
    "planMode": false,
    "maxIterations": 10,
    "maxConsecutiveErrors": 10,
    "activityTimeoutSeconds": null,
    "stopPattern": "<promise>COMPLETE</promise>$",
    "git": { "branchPrefix": "", "commitScope": "" },
    "baseBranch": "main",
    "clearPlanningFolder": false,
    "autoAcceptPlan": false,
    "fullyAutonomous": false,
    "draft": true
  }'

# Response: {"config":{"id":"abc-123",...},"state":{"status":"draft",...}}

# Later, update the draft
curl -X PUT http://localhost:3000/api/tasks/abc-123 \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Implement JWT-based authentication with refresh tokens"
  }'

# Start the draft
curl -X POST http://localhost:3000/api/tasks/abc-123/draft/start \
  -H "Content-Type: application/json" \
  -d '{"planMode": false, "attachments": []}'
```

### Create a Task with Plan Mode

Plan mode lets you review and refine the plan before execution.

```bash
# Create a task in plan mode
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "refactor-auth-module",
    "workspaceId": "ws-abc123",
    "prompt": "Refactor the authentication module to use async/await",
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

# Response: {"config":{"id":"abc-123",...},"state":{"status":"planning",...}}

# Send feedback on the plan
curl -X POST http://localhost:3000/api/tasks/abc-123/plan/feedback \
  -H "Content-Type: application/json" \
  -d '{"feedback": "Also consider adding error handling for token expiration", "attachments": []}'

# Accept the plan and start execution
curl -X POST http://localhost:3000/api/tasks/abc-123/plan/accept \
  -H "Content-Type: application/json" \
  -d '{"mode": "start_task"}'
```

### Modify Next Iteration Prompt

```bash
# While task is running, set a pending prompt
curl -X PUT http://localhost:3000/api/tasks/abc-123/pending-prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Continue, but also add unit tests for the auth module", "attachments": []}'
```

### Accept Completed Task

```bash
# After task completes, review and accept
curl -X POST http://localhost:3000/api/tasks/abc-123/accept
# Response: {"success":true}
```

### Address Reviewer Comments

After pushing a task, you can address reviewer comments:

```bash
# Push the task first
curl -X POST http://localhost:3000/api/tasks/abc-123/push
# Response: {"success":true,"remoteBranch":"add-dark-mode-toggle-a1b2c3d","syncStatus":"clean"}

# Later, address reviewer comments
curl -X POST http://localhost:3000/api/tasks/abc-123/address-comments \
  -H "Content-Type: application/json" \
  -d '{"comments": "Please fix the type errors and add error handling", "attachments": []}'
# Response: {"success":true,"reviewCycle":1,"branch":"add-dark-mode-toggle-a1b2c3d-review-1"}

# Get review history
curl http://localhost:3000/api/tasks/abc-123/review-history
# Response: {"success":true,"history":{"addressable":true,"completionAction":"push","reviewCycles":1,"reviewBranches":[]}}
```
