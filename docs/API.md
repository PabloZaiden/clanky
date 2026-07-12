# Clanky API Reference

This document describes the REST API for the Clanky Task Management System.

## Base URL

```
http://localhost:3000/api
```

The port can be configured via the `CLANKY_PORT` environment variable, and the bind host can be configured via `CLANKY_HOST`.

## Authentication

Authentication, users, passkeys, API keys, device auth, health, theme, log level, and server operations are provided by `@pablozaiden/webapp`. This document covers Clanky-owned domain endpoints only.

`clanky auth` uses the framework device flow, `clanky api` sends authenticated REST calls with stored framework tokens, `clanky ws` opens authenticated websocket sessions against `/api/ws`, `clanky schema` exposes discoverability metadata for catalogued Clanky endpoints, and `clanky update` checks or installs published Clanky release binaries from GitHub Releases.

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
clanky auth http://localhost:3000

# List discoverable endpoints
clanky api

# Invoke an authenticated API request (prints one JSON object)
clanky api tasks/my-task --method GET

# Inspect the schema metadata for an endpoint
clanky schema tasks

# Stream websocket events over stdio
clanky ws --task-id my-task
```

`clanky help` includes the same version banner shown by `clanky version`, which makes it easier to confirm the client version while browsing the built-in command list. `clanky update` currently supports only the published Linux and macOS release binary, prints progress while release metadata and downloads are in flight, and should not be used from a Bun source checkout. `clanky api <endpoint>` emits a single JSON envelope so scripts can always parse the output. `clanky ws` reuses the stored CLI auth state, writes inbound websocket frames to stdout one line at a time, reads one JSON value per non-empty stdin line, and sends diagnostics to stderr so stdout stays machine-safe.

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

All responses are JSON. Successful responses return the requested data directly. Error responses follow this format:

```json
{
  "error": "error_code",
  "message": "Human-readable error description"
}
```

## ACP Agent Runtime Architecture

Clanky runs agent interactions through ACP JSON-RPC and supports the following providers:

- `opencode` (CLI command: `opencode acp`)
- `copilot` (CLI command: `copilot --yolo --acp`)
- `codex` (CLI command: resolves `codex-acp`, or runs `@agentclientprotocol/codex-acp` through `npx`/`bunx`, with full-access runtime settings)
- `claude` (CLI command: resolves `claude-agent-acp`, or runs `@agentclientprotocol/claude-agent-acp` through `npx`/`bunx`)

Agent transport is configured per workspace:

1. **Local ACP** (`stdio`): provider CLI is launched on the local host.
2. **Remote ACP** (`ssh`): provider CLI is launched over SSH on the target workspace host.

When `CLANKY_MOCK_ACP=true`, local `stdio` workspaces use Clanky's built-in fake ACP runtime instead of launching the provider CLI. This is intended for testing and exercises ACP flows such as initialization, authentication, session lifecycle, prompt streaming, tool events, permission requests, question flows, config updates, file-system requests, terminal requests, and cancellation.

This agent channel handles sessions, prompts, streaming updates, tool events, and permission/question requests.

## Command Execution Architecture

All API endpoints that perform deterministic server-side operations (git commands, file operations, etc.) use the `CommandExecutor` abstraction:

1. **Local execution** (`stdio` transport): commands run directly on the local host.
2. **Remote execution** (`ssh` transport): commands run over SSH on the target workspace host.
3. **Bounded execution**: command operations enforce timeouts and explicit success/failure results.

This execution channel is decoupled from ACP streaming/provider internals. The following operations use deterministic command execution:

- Git operations (`/api/git/branches`, task git operations)
- File existence checks (`/api/check-planning-dir`)
- File reads (`/api/tasks/:id/plan`, `/api/tasks/:id/status-file`)
- Directory listings

## Endpoints

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
| `model` | object | Yes | Model selection |
| `model.providerID` | string | Yes | Provider ID (e.g., "anthropic") |
| `model.modelID` | string | Yes | Model ID (e.g., "claude-sonnet-4-20250514") |
| `model.variant` | string | No | Model variant (e.g., "thinking") |
| `useWorktree` | boolean | Yes | Whether to run the task in a dedicated git worktree |
| `planMode` | boolean | Yes | Start in plan creation mode |
| `planModeAutoReply` | boolean | No | Whether planning-mode ACP questions should be auto-answered instead of waiting for a manual reply (default: `true`) |
| `maxIterations` | number | No | Maximum iterations (unlimited if not set) |
| `maxConsecutiveErrors` | number | No | Max errors before failsafe (default: 10) |
| `activityTimeoutSeconds` | number \| null | No | Seconds without events before treating as error. Use `null` or omit the field for unlimited timeout; finite values must be at least 60 seconds. |
| `stopPattern` | string | No | Completion regex (default: `<promise>COMPLETE</promise>$`) |
| `git` | object | No | Git configuration |
| `git.branchPrefix` | string | No | Optional prefix prepended before the generated `title-hash` branch name (default: empty string). Non-empty values are normalized to git-safe path segments and stored with a trailing `/`. |
| `git.commitScope` | string | No | Optional Conventional Commit scope override (default: empty string). When provided, use a meaningful module, section, or topic such as `"auth"` or `"api"`. Leave it empty to generate scope-less commits. Generic placeholder values such as `"clanky"` are treated as empty. The deprecated `git.commitPrefix` is still accepted and converted the same way. |
| `baseBranch` | string | No | Base branch to create the task from (default: auto-detected default branch) |
| `clearPlanningFolder` | boolean | No | Clear .clanky-planning folder before starting (default: false) |
| `draft` | boolean | No | Save as draft without starting (default: false) |

**Example Request**

```json
{
  "name": "implement-dark-mode-toggle",
  "workspaceId": "ws-abc123",
  "prompt": "Implement a dark mode toggle in the settings page. Use CSS variables for theming.",
  "issueNumber": 123,
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514"
  },
  "useWorktree": true,
  "planMode": false,
  "maxIterations": 10,
  "activityTimeoutSeconds": null
}
```

Use `POST /api/tasks/title` if you want Clanky to suggest a name from the prompt before calling this endpoint.

**Response**

Returns the created task object with status `201 Created`.

- If `draft: true`, the task is saved with status `draft` and no git branch is created
- If `planMode: true`, the task starts in `planning` status
- Otherwise, the task is started immediately and returns with status `running`

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
  "prompt": "Implement JWT-based authentication with login and signup endpoints"
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

Update a task's configuration. Cannot be used on running or starting tasks — stop the task first.

**Request Body**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Update the task name |
| `directory` | string | Update working directory |
| `prompt` | string | Update prompt |
| `issueNumber` | positive integer \| null | Update the linked GitHub issue number; send `null` to clear the existing issue link |
| `model` | object | Update model |
| `maxIterations` | number | Update max iterations |
| `maxConsecutiveErrors` | number | Update max consecutive errors |
| `activityTimeoutSeconds` | number \| null | Update activity timeout (`null` clears it to unlimited) |
| `stopPattern` | string | Update stop pattern |
| `baseBranch` | string | Update base branch |
| `useWorktree` | boolean | Update worktree usage before the task has started |
| `clearPlanningFolder` | boolean | Update clear planning folder flag |
| `planMode` | boolean | Update plan mode flag |
| `planModeAutoReply` | boolean | Update whether planning-mode ACP questions auto-answer |
| `git` | object | Update git config (partial) |

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

Start a draft task. Transitions the task from `draft` status to either `planning` or `running`.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `planMode` | boolean | Yes | If true, start in plan mode; if false, start immediately |

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

Accept a completed task and merge its branch.

**Response**

```json
{
  "success": true,
  "mergeCommit": "abc123..."
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `accept_failed` | Cannot accept (e.g., task still running) |

#### POST /api/tasks/:id/push

Push a completed task's branch to remote for PR workflow.

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

Permanently delete a merged or deleted task from storage.

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
| 400 | `purge_failed` | Cannot purge (task not in final state) |

#### GET /api/tasks/:id/ssh-session

Get the persistent SSH session linked to a task.

**Response**

Returns the SSH session object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task or linked SSH session not found |
| 400 | `invalid_session_configuration` | Task cannot open an SSH session with its current transport/setup |
| 500 | `ssh_session_error` | Failed to read SSH session data |

#### POST /api/tasks/:id/ssh-session

Create or reuse the persistent SSH session linked to a task.

**Response**

Returns the SSH session object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `invalid_session_configuration` | Task cannot open an SSH session with its current transport/setup |
| 500 | `ssh_session_error` | Failed to create the SSH session |

#### GET /api/tasks/:id/port-forwards

List all port forwards associated with a task.

**Response**

Returns an array of port-forward objects.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 500 | `port_forward_error` | Failed to list port forwards |

#### POST /api/tasks/:id/port-forwards

Create a new port forward for a task's SSH-backed workspace.

**Request Body**

```json
{
  "remotePort": 3000
}
```

**Response**

Returns the created port-forward object with status `201 Created`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 409 | `duplicate_port_forward` | The same remote port is already being forwarded for this workspace |
| 400 | `invalid_port_forward_configuration` | The task cannot create a port forward with its current transport/setup |
| 500 | `port_forward_error` | Failed to create the port forward |

#### DELETE /api/tasks/:id/port-forwards/:forwardId

Delete a task port forward.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Port forward not found |
| 500 | `port_forward_error` | Failed to delete the port forward |

#### POST /api/tasks/:id/mark-merged

Mark a task as externally merged and transition it to `deleted`.

This is useful when a task branch was merged outside Clanky (for example through a hosted pull-request flow) and you want to clean up the task state without performing an in-app merge. In worktree-backed flows, branch/worktree cleanup remains part of the normal discard/purge lifecycle.

Only works for tasks in final states (pushed, merged, completed, max_iterations, deleted).

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

Set pending message and/or model for next iteration. By default (`immediate: true`), running ACP-backed tasks prefer staying on the active session and applying the pending values on the very next iteration without interrupting the current turn. If the backend cannot support that flow, it falls back to interrupting the current iteration. Set `immediate: false` to wait for the current iteration to complete naturally.

Works for active tasks (running, waiting, planning, starting) and can also jumpstart tasks in supported stopped states (completed, stopped, failed, max_iterations).

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | No | Message to queue for next iteration |
| `model` | object | No | Model change: `{ providerID, modelID }` |
| `immediate` | boolean | No | If true (default), prefer queueing on the active ACP session for running tasks and fall back to interruption when unsupported. If false, wait for the current iteration to complete. |

At least one of `message` or `model` must be provided.

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

### Pending Prompt (Legacy)

Modify the prompt for the next iteration while a task is running.

#### PUT /api/tasks/:id/pending-prompt

Set the pending prompt for the next iteration.

**Request Body**

```json
{
  "prompt": "Also update the tests for the feature"
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
  "feedback": "Please also consider error handling for edge cases"
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

Accept the plan and either start autonomous execution or hand the work off to SSH.

The request body is optional. When omitted, Clanky uses the default acceptance behavior.

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

When the accepted plan is handed off directly to SSH:

```json
{
  "success": true,
  "mode": "open_ssh",
  "sshSession": {
    "config": {
      "id": "ssh-uuid",
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

#### POST /api/tasks/:id/plan/question/answer

Answer a pending planning-mode question that requires manual input.

**Request Body**

```json
{
  "answers": [
    ["Use Bun's built-in HTTP server"],
    ["Add unit tests"]
  ]
}
```

Each outer array item corresponds to a question. Each inner array contains the selected answer values for that question.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 409 | `no_pending_plan_question` | There is no question waiting for an answer |
| 400 | `not_planning` | Task is not in planning status |
| 400 | `invalid_question_answer` | Answers do not match the question shape/options |
| 500 | `answer_plan_question_failed` | Failed to submit the answer |

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

After a task is pushed or merged, reviewers can submit comments that the task will address.

#### POST /api/tasks/:id/address-comments

Start addressing reviewer comments. Creates a new review cycle and restarts the task.

**Request Body**

```json
{
  "comments": "Please fix the type errors in the auth module and add unit tests"
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

Start a new follow-up cycle from a restartable terminal state.

For pushed or merged tasks, this starts a review-feedback cycle. For other restartable task states, it queues the message and restarts the work on the existing task.

**Request Body**

```json
{
  "message": "Please address the latest review feedback and keep the existing branch history clean.",
  "model": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514"
  }
}
```

The `model` override is optional and applies to the restarted follow-up work.

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
  "modelID": "claude-sonnet-4-20250514"
}
```

Returns `null` if no model has been used.

#### PUT /api/preferences/last-model

Set the last used model.

**Request Body**

```json
{
  "providerID": "anthropic",
  "modelID": "claude-sonnet-4-20250514"
}
```

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

---

### Configuration

#### GET /api/config

Get application configuration based on environment.

**Response**

```json
{
  "remoteOnly": false,
  "publicBasePath": "/clanky"
}
```

| Field | Description |
|-------|-------------|
| `remoteOnly` | If true, local `stdio` transport is disabled and only `ssh` transport is allowed (set via CLANKY_REMOTE_ONLY env var) |
| `publicBasePath` | Optional base path inferred from reverse-proxy `X-Forwarded-Prefix` headers |

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

Workspaces represent projects managed by Clanky. Each workspace is identified by its ID, has its own server connection settings, and can have multiple tasks. The configured directory is used only as the workspace execution location.

#### GET /api/workspaces

List all workspaces.

**Response**

```json
[
  {
    "id": "ws-uuid",
    "name": "My Project",
    "directory": "/path/to/project",
    "serverSettings": {
      "agent": {
        "provider": "opencode",
        "transport": "stdio"
      }
    },
    "createdAt": "2026-01-20T10:00:00.000Z",
    "updatedAt": "2026-01-20T10:00:00.000Z"
  }
]
```

#### POST /api/workspaces

Create a new workspace. Validates that its execution directory exists on the remote server and is a git repository.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Workspace display name |
| `directory` | string | Yes | Absolute path to git repository |
| `serverSettings` | object | No | Workspace connection settings (defaults to `{ agent: { provider: "opencode", transport: "stdio" } }`) |

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
| `serverSettings` | object | Update server connection settings |

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

#### GET /api/workspaces/export

Export all workspace configurations as JSON for backup or migration.

**Response**

```json
{
  "version": 1,
  "exportedAt": "2026-01-20T10:00:00.000Z",
  "workspaces": [
    {
      "name": "My Project",
      "directory": "/path/to/project",
      "serverSettings": {
        "agent": {
          "provider": "opencode",
          "transport": "stdio"
        }
      }
    }
  ]
}
```

#### POST /api/workspaces/import

Import workspace configurations from JSON. Each workspace's execution directory is validated on the remote server before creation. Every valid entry creates a new workspace, even when its directory matches another workspace.

**Request Body**

```json
{
  "version": 1,
  "workspaces": [
    {
      "name": "My Project",
      "directory": "/path/to/project",
      "serverSettings": {
        "agent": {
          "provider": "opencode",
          "transport": "stdio"
        }
      }
    }
  ]
}
```

**Response**

```json
{
  "created": 2,
  "failed": 0,
  "details": [
    { "name": "Project A", "directory": "/path/a", "status": "created" },
    { "name": "Project C", "directory": "/path/c", "status": "created" }
  ]
}
```

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

Server settings are configured per-workspace. Each workspace can have different connection settings, allowing different providers/transports per project.
Settings use a single contract:

```json
{
  "agent": {
    "provider": "opencode | copilot | codex | claude | pi | grok",
    "transport": "stdio | ssh",
    "hostname": "required for ssh",
    "port": 22,
    "username": "optional",
    "password": "optional",
    "identityFile": "optional"
  }
}
```

Execution behavior is derived automatically from `agent.transport`:
- `stdio` → local deterministic execution
- `ssh` → remote deterministic execution over SSH

Provider runtime command is derived from `agent.provider`:
- `opencode` → `opencode acp`
- `copilot` → `copilot --yolo --acp`
- `codex` → resolves `codex-acp`, or runs `@agentclientprotocol/codex-acp` through `npx`/`bunx`, with Codex configured for non-interactive full-access ACP execution
- `claude` → resolves `claude-agent-acp`, or runs `@agentclientprotocol/claude-agent-acp` through `npx`/`bunx`
- `pi` → resolves `pi-acp`, or runs `pi-acp` through `npx`/`bunx`
- `grok` → resolves `grok`, or runs `@xai-official/grok` through `npx`/`bunx`, using `grok agent --always-approve stdio`

For `codex`, Clanky passes the following runtime environment to the provider on
both `stdio` and `ssh` transports:

```sh
INITIAL_AGENT_MODE=agent-full-access
CODEX_CONFIG='{"approval_policy":"never","sandbox_mode":"danger-full-access"}'
```

`CODEX_CONFIG` is parsed by `codex-acp` as a JSON object and merged into each
Codex session configuration.

If `CLANKY_MOCK_ACP=true`, local `stdio` launches use the built-in mock ACP runtime regardless of the selected provider so end-to-end tests can exercise ACP transport behavior without an external agent CLI.

#### GET /api/workspaces/:id/server-settings

Get server settings for a specific workspace.

**Response**

```json
{
  "agent": {
    "provider": "opencode",
    "transport": "stdio"
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
| `agent.transport` | string | Yes | `stdio` or `ssh` |
| `agent.hostname` | string | For `ssh` | SSH hostname |
| `agent.port` | number | No | SSH port (default `22`) |
| `agent.username` | string | No | SSH username |
| `agent.password` | string | No | SSH password |
| `agent.identityFile` | string | No | Path to an SSH private key file to use instead of password auth |

**Response**

```json
{
  "agent": {
    "provider": "copilot",
    "transport": "ssh",
    "hostname": "remote.example.com",
    "port": 22,
    "username": "vscode",
    "password": "***"
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
  "transport": "ssh",
  "capabilities": ["createSession", "sendPromptAsync", "abortSession", "queueActivePrompt", "subscribeToEvents", "models"],
  "serverUrl": "ssh://remote.example.com:22",
  "directoryExists": true,
  "isGitRepo": true
}
```

`capabilities` lists high-level runtime operations exposed by the selected provider. For example, `opencode` includes `models`, while `copilot` and `codex` currently do not.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |

#### POST /api/workspaces/:id/server-settings/test

Test connection with provided settings for a workspace.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent.provider` | string | Yes | `opencode`, `copilot`, `codex`, `claude`, `pi`, or `grok` |
| `agent.transport` | string | Yes | `stdio` or `ssh` |
| `agent.hostname` | string | For `ssh` | SSH hostname |
| `agent.port` | number | No | SSH port (default `22`) |
| `agent.username` | string | No | SSH username |
| `agent.password` | string | No | SSH password |
| `agent.identityFile` | string | No | Path to an SSH private key file to use instead of password auth |

If no body (or `{}`) is provided, the workspace's current settings are used.

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

Test a server connection without requiring a workspace. Useful for validating connection settings before creating a workspace.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `settings` | object | Yes | Server settings to test |
| `settings.agent.provider` | string | Yes | `opencode`, `copilot`, `codex`, `claude`, `pi`, or `grok` |
| `settings.agent.transport` | string | Yes | `stdio` or `ssh` |
| `settings.agent.hostname` | string | For `ssh` | SSH hostname |
| `settings.agent.port` | number | No | SSH port (default `22`) |
| `settings.agent.username` | string | No | SSH username |
| `settings.agent.password` | string | No | SSH password |
| `settings.agent.identityFile` | string | No | Path to an SSH private key file to use instead of password auth |
| `directory` | string | Yes | Directory path to test against |

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

Delete database and reinitialize. This is a destructive operation that deletes all tasks, workspaces, sessions, and preferences. The database is recreated fresh with all migrations applied.

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

### SSH Sessions

Workspace-backed SSH sessions are persistent dtach-backed sessions created against SSH-configured workspaces.

#### GET /api/ssh-sessions

List SSH sessions. Optionally filter to one workspace.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `workspaceId` | No | Restrict results to one workspace |

**Response**

Returns an array of SSH session objects.

#### POST /api/ssh-sessions

Create a persistent SSH session for a workspace.

**Request Body**

```json
{
  "workspaceId": "ws-abc123",
  "name": "Debug Shell"
}
```

**Response**

Returns the created SSH session object with status `201 Created`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_session_configuration` | The workspace cannot open a persistent SSH session with its current setup |
| 400 | `validation_error` | Missing or invalid request fields |
| 404 | `not_found` | Workspace not found |
| 500 | `ssh_session_error` | Failed to create the session |

#### GET /api/ssh-sessions/:id

Get one SSH session.

#### PATCH /api/ssh-sessions/:id

Rename an SSH session.

**Request Body**

```json
{
  "name": "Renamed Shell"
}
```

#### DELETE /api/ssh-sessions/:id

Delete an SSH session.

**Response**

```json
{
  "success": true
}
```

---

### Standalone SSH Servers

Standalone SSH servers let the browser register reusable SSH targets, exchange encrypted credentials, and create terminal sessions that are not tied to a workspace.

#### GET /api/ssh-servers

List registered standalone SSH servers.

#### POST /api/ssh-servers

Create a standalone SSH server entry.

**Request Body**

```json
{
  "name": "Build Box",
  "address": "build.example.com",
  "username": "vscode"
}
```

**Response**

Returns the created SSH server object with status `201 Created`.

#### GET /api/ssh-servers/:id

Get one standalone SSH server.

#### PATCH /api/ssh-servers/:id

Update a standalone SSH server.

**Request Body**

Provide one or more of: `name`, `address`, `username`.

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

#### GET /api/ssh-servers/:id/sessions

List standalone SSH server sessions.

#### POST /api/ssh-servers/:id/sessions

Create a standalone SSH server session.

**Request Body**

```json
{
  "name": "Emergency Shell",
  "credentialToken": "token-uuid"
}
```

#### GET /api/ssh-server-sessions/:id

Get one standalone SSH server session.

#### PATCH /api/ssh-server-sessions/:id

Rename a standalone SSH server session.

**Request Body**

```json
{
  "name": "Renamed Emergency Shell"
}
```

#### DELETE /api/ssh-server-sessions/:id

Delete a standalone SSH server session.

**Request Body**

```json
{
  "credentialToken": "token-uuid"
}
```

**Response**

```json
{
  "success": true
}
```

---

### Provisioning

Provisioning jobs create or reuse a remote workspace by cloning a repository onto a registered standalone SSH server, preparing the environment, and creating the resulting workspace in Clanky.

#### POST /api/provisioning-jobs

Create a provisioning job.

**Request Body**

```json
{
  "name": "clanky-demo",
  "sshServerId": "ssh-server-uuid",
  "repoUrl": "https://github.com/example/repo.git",
  "basePath": "/workspaces",
  "provider": "copilot",
  "credentialToken": "token-uuid"
}
```

`provider` accepts `"copilot"`, `"opencode"`, `"codex"`, `"claude"`, `"pi"`, or `"grok"` and defaults to `"copilot"` when omitted. `credentialToken` is optional and is used when the target SSH server requires an exchanged credential.

**Response**

Returns the created provisioning job snapshot with status `201 Created`.

```json
{
  "job": {
    "config": {
      "id": "prov-uuid",
      "name": "clanky-demo",
      "sshServerId": "ssh-server-uuid",
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

---

### Events (WebSocket)

#### WS /api/ws

WebSocket endpoint for real-time event streaming. Supports optional task and SSH-session filtering.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `taskId` | No | Filter events to a specific task |
| `chatId` | No | Filter chat events to a specific chat |
| `sshSessionId` | No | Filter SSH session events to a specific workspace-backed SSH session |
| `sshServerSessionId` | No | Filter SSH session events to a specific standalone SSH server session |
| `provisioningJobId` | No | Filter provisioning events to a specific provisioning job |

**Connection URL Examples**

```
ws://localhost:3000/api/ws              # All events
ws://localhost:3000/api/ws?taskId=abc   # Events for task "abc" only
ws://localhost:3000/api/ws?sshSessionId=ssh-123
wss://example.com/api/ws                # Secure WebSocket
```

**CLI bridge example**

```bash
# Connect using stored CLI credentials and stream one task only
clanky ws --task-id abc-123

# Override the base URL explicitly
clanky ws https://example.com/clanky --provisioning-job-id job-42
```

`clanky ws` uses the same stored bearer token and cookie state as `clanky status` and `clanky api`. The command upgrades a websocket connection to `/api/ws`, prints each incoming text frame to stdout unchanged, accepts one JSON value per non-empty stdin line, and exits non-zero on invalid stdin, auth/connection failures, or abnormal websocket termination.

**Connection Message**

Upon successful connection, the server sends a confirmation:

```json
{"type":"connected","taskId":null}
```

If `taskId` was specified:

```json
{"type":"connected","taskId":"abc-123"}
```

**Event Types**

Each event is a JSON object with a `type` field:

| Event Type | Description |
|------------|-------------|
| `task.created` | New task was created |
| `task.started` | Task execution started |
| `task.iteration.start` | Iteration began |
| `task.iteration.end` | Iteration completed |
| `task.message` | AI message received |
| `task.tool_call` | Tool was invoked |
| `task.progress` | Streaming text delta |
| `task.log` | Application log entry |
| `task.git.commit` | Git commit made |
| `task.completed` | Task finished successfully |
| `task.ssh_handoff` | Plan was accepted by opening an SSH session instead of starting autonomous execution |
| `task.stopped` | Task was stopped manually |
| `task.session_aborted` | AI session was aborted |
| `task.error` | Error occurred |
| `task.deleted` | Task was deleted |
| `task.accepted` | Branch was merged |
| `task.pushed` | Branch was pushed to remote |
| `task.discarded` | Branch was deleted |
| `task.sync.started` | Branch sync with base started |
| `task.sync.clean` | Branch sync completed cleanly |
| `task.sync.conflicts` | Merge conflicts detected during sync |
| `task.plan.ready` | Plan is ready for review (planning mode) |
| `task.plan.feedback` | Feedback was sent on plan |
| `task.plan.accepted` | Plan was accepted, execution starting |
| `task.plan.discarded` | Plan was discarded, task deleted |
| `task.todo.updated` | TODO list was updated |
| `task.pending.updated` | Pending message/model was updated |
| `ssh_session.created` | SSH session was created |
| `ssh_session.updated` | SSH session metadata was updated |
| `ssh_session.deleted` | SSH session was deleted |
| `ssh_session.status` | SSH session connection state changed |
| `ssh_session.port_forward.created` | Port forward was created |
| `ssh_session.port_forward.updated` | Port forward metadata was updated |
| `ssh_session.port_forward.deleted` | Port forward was deleted |
| `ssh_session.port_forward.status` | Port forward lifecycle state changed |

**Keep-Alive**

Send a ping message to receive a pong response:

```json
// Client sends:
{"type":"ping"}

// Server responds:
{"type":"pong"}
```

**Example Events**

```json
{"type":"task.iteration.start","taskId":"abc-123","iteration":3,"timestamp":"2026-01-20T10:15:00.000Z"}

{"type":"task.log","taskId":"abc-123","id":"log-1","level":"info","message":"Sending prompt to AI","timestamp":"2026-01-20T10:15:01.000Z"}

{"type":"task.tool_call","taskId":"abc-123","iteration":3,"tool":{"id":"tc-1","name":"Write","input":{"path":"/src/foo.ts"},"status":"running"},"timestamp":"2026-01-20T10:15:05.000Z"}

{"type":"task.plan.ready","taskId":"abc-123","planContent":"# Plan\n\n## Goals\n...","timestamp":"2026-01-20T10:16:00.000Z"}

{"type":"task.todo.updated","taskId":"abc-123","todos":[{"id":"1","content":"Implement feature","status":"in_progress"}],"timestamp":"2026-01-20T10:17:00.000Z"}
```

**JavaScript Example**

```javascript
const ws = new WebSocket('ws://localhost:3000/api/ws');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'connected') {
    console.log('Connection confirmed');
    return;
  }
  console.log('Event:', data.type, data);
};

ws.onclose = () => {
  console.log('Disconnected');
  // Implement reconnection logic as needed
};
```

#### WS /api/ssh-terminal

Dedicated WebSocket endpoint for interactive SSH terminal sessions.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sshSessionId` | One of `sshSessionId` or `sshServerSessionId` is required | Connect to a workspace-backed SSH session |
| `sshServerSessionId` | One of `sshSessionId` or `sshServerSessionId` is required | Connect to a standalone SSH server session |

Standalone SSH server sessions require an initial auth message after the socket opens:

```json
{
  "type": "terminal.auth",
  "credentialToken": "token-uuid"
}
```

The terminal socket emits events such as `terminal.connected`, `terminal.output`, `terminal.clipboard`, `terminal.error`, and `terminal.closed`.

#### Forwarded Port Proxy Routes

Active task port forwards are exposed through browser-facing proxy routes:

- `GET /task/:taskId/port/:forwardId`
- `GET /task/:taskId/port/:forwardId/*`
- WebSocket upgrades on the same paths

These routes proxy HTTP and WebSocket traffic to the task's forwarded remote service and rewrite absolute paths/redirects so browser apps can run under the task-scoped prefix.

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
| `merged` | Changes merged into original branch |
| `pushed` | Branch pushed to remote (can receive reviews) |
| `deleted` | Marked for deletion (terminal state) |

Note: Only `deleted` is a true terminal state (no further transitions possible). `merged` and `pushed` can transition to `idle` (restart) or `deleted`.

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

Clanky generates commit messages following the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification:

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
    "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-20250514" },
    "useWorktree": true,
    "planMode": false
  }'

# Response: {"config":{"id":"abc-123",...},"state":{"status":"running",...}}

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
    "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-20250514" },
    "useWorktree": true,
    "planMode": false,
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
  -d '{"planMode": false}'
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
    "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-20250514" },
    "useWorktree": true,
    "planMode": true
  }'

# Response: {"config":{"id":"abc-123",...},"state":{"status":"planning",...}}

# Send feedback on the plan
curl -X POST http://localhost:3000/api/tasks/abc-123/plan/feedback \
  -H "Content-Type: application/json" \
  -d '{"feedback": "Also consider adding error handling for token expiration"}'

# Accept the plan and start execution
curl -X POST http://localhost:3000/api/tasks/abc-123/plan/accept
```

### Modify Next Iteration Prompt

```bash
# While task is running, set a pending prompt
curl -X PUT http://localhost:3000/api/tasks/abc-123/pending-prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Continue, but also add unit tests for the auth module"}'
```

### Accept Completed Task

```bash
# After task completes, review and accept
curl -X POST http://localhost:3000/api/tasks/abc-123/accept
# Response: {"success":true,"mergeCommit":"def456..."}
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
  -d '{"comments": "Please fix the type errors and add error handling"}'
# Response: {"success":true,"reviewCycle":1,"branch":"add-dark-mode-toggle-a1b2c3d-review-1"}

# Get review history
curl http://localhost:3000/api/tasks/abc-123/review-history
# Response: {"success":true,"history":{"addressable":true,"completionAction":"push","reviewCycles":1,"reviewBranches":[]}}
```
