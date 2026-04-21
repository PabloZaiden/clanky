# Ralpher API Reference

This document describes the REST API for the Ralpher Loop Management System.

## Base URL

```
http://localhost:3000/api
```

The port can be configured via the `RALPHER_PORT` environment variable, and the bind host can be configured via `RALPHER_HOST`.

## Authentication

By default, the API does not require application-level credentials. In production deployments, Ralpher is still expected to run behind a reverse proxy that enforces authentication and authorization.

When passkey authentication is configured, browser requests use a passkey session cookie and non-browser clients can authenticate with bearer tokens issued by the device flow. The public bootstrap remains available so the SPA can render the login gate and call the passkey auth endpoints. Set `RALPHER_DISABLE_PASSKEY=true` to bypass application-level passkey enforcement.

The `ralpher cli` subcommands use the device flow endpoints plus `GET /api/auth/status` to validate stored bearer credentials.

## Response Format

All responses are JSON. Successful responses return the requested data directly. Error responses follow this format:

```json
{
  "error": "error_code",
  "message": "Human-readable error description"
}
```

## ACP Agent Runtime Architecture

Ralpher runs agent interactions through ACP JSON-RPC and supports two providers:

- `opencode` (CLI command: `opencode acp`)
- `copilot` (CLI command: `copilot --yolo --acp`)

Agent transport is configured per workspace:

1. **Local ACP** (`stdio`): provider CLI is launched on the local host.
2. **Remote ACP** (`ssh`): provider CLI is launched over SSH on the target workspace host.

When `RALPHER_MOCK_ACP=true`, local `stdio` workspaces use Ralpher's built-in fake ACP runtime instead of launching the provider CLI. This is intended for testing and exercises ACP flows such as initialization, authentication, session lifecycle, prompt streaming, tool events, permission requests, question flows, config updates, file-system requests, terminal requests, and cancellation.

This agent channel handles sessions, prompts, streaming updates, tool events, and permission/question requests.

## Command Execution Architecture

All API endpoints that perform deterministic server-side operations (git commands, file operations, etc.) use the `CommandExecutor` abstraction:

1. **Local execution** (`stdio` transport): commands run directly on the local host.
2. **Remote execution** (`ssh` transport): commands run over SSH on the target workspace host.
3. **Bounded execution**: command operations enforce timeouts and explicit success/failure results.

This execution channel is decoupled from ACP streaming/provider internals. The following operations use deterministic command execution:

- Git operations (`/api/git/branches`, loop git operations)
- File existence checks (`/api/check-planning-dir`)
- File reads (`/api/loops/:id/plan`, `/api/loops/:id/status-file`)
- Directory listings

## Endpoints

### Health Check

#### GET /api/health

Check if the server is running.

**Response**

```json
{
  "healthy": true,
  "version": "0.0.0-development"
}
```

The `version` field is read from `package.json` at startup and will reflect the actual build version.

---

### Auth Status

#### GET /api/auth/status

Validate whether the current passkey session or bearer token is authenticated.

This endpoint is protected by the normal application-auth layer, so unauthenticated requests receive a `401` response.

**Response**

```json
{
  "authenticated": true,
  "authKind": "bearer",
  "subject": "ralpher-user",
  "clientId": "ralpher-cli",
  "scope": ""
}
```

---

### Loops CRUD

#### GET /api/loops

List all loops.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|

**Response**

```json
[
  {
    "config": {
      "id": "uuid",
      "name": "My Loop",
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

#### POST /api/loops

Create a new loop.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Loop name shown in the UI. The dashboard can generate a suggested name with `POST /api/loops/title`, but the final value is submitted by the client. |
| `workspaceId` | string | Yes | ID of the workspace to create the loop in |
| `prompt` | string | Yes | Task prompt/PRD (non-empty) |
| `model` | object | Yes | Model selection |
| `model.providerID` | string | Yes | Provider ID (e.g., "anthropic") |
| `model.modelID` | string | Yes | Model ID (e.g., "claude-sonnet-4-20250514") |
| `model.variant` | string | No | Model variant (e.g., "thinking") |
| `useWorktree` | boolean | Yes | Whether to run the loop in a dedicated git worktree |
| `planMode` | boolean | Yes | Start in plan creation mode |
| `planModeAutoReply` | boolean | No | Whether planning-mode ACP questions should be auto-answered instead of waiting for a manual reply (default: `true`) |
| `maxIterations` | number | No | Maximum iterations (unlimited if not set) |
| `maxConsecutiveErrors` | number | No | Max errors before failsafe (default: 10) |
| `activityTimeoutSeconds` | number \| null | No | Seconds without events before treating as error. Use `null` or omit the field for unlimited timeout; finite values must be at least 60 seconds. |
| `stopPattern` | string | No | Completion regex (default: `<promise>COMPLETE</promise>$`) |
| `git` | object | No | Git configuration |
| `git.branchPrefix` | string | No | Optional prefix prepended before the generated `title-hash` branch name (default: empty string). Non-empty values are normalized to git-safe path segments and stored with a trailing `/`. |
| `git.commitScope` | string | No | Optional Conventional Commit scope override (default: empty string). When provided, use a meaningful module, section, or topic such as `"auth"` or `"api"`. Leave it empty to generate scope-less commits. Generic placeholder values such as `"ralph"` are treated as empty. The deprecated `git.commitPrefix` is still accepted and converted the same way. |
| `baseBranch` | string | No | Base branch to create the loop from (default: auto-detected default branch) |
| `clearPlanningFolder` | boolean | No | Clear .ralph-planning folder before starting (default: false) |
| `draft` | boolean | No | Save as draft without starting (default: false) |

**Example Request**

```json
{
  "name": "implement-dark-mode-toggle",
  "workspaceId": "ws-abc123",
  "prompt": "Implement a dark mode toggle in the settings page. Use CSS variables for theming.",
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

Use `POST /api/loops/title` if you want Ralpher to suggest a name from the prompt before calling this endpoint.

**Response**

Returns the created loop object with status `201 Created`.

- If `draft: true`, the loop is saved with status `draft` and no git branch is created
- If `planMode: true`, the loop starts in `planning` status
- Otherwise, the loop is started immediately and returns with status `running`

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Missing or invalid fields |
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `model_not_enabled` | The selected model is not available or not connected |
| 400 | `provider_not_found` | The specified provider was not found |
| 400 | `model_not_found` | The specified model was not found on the provider |
| 404 | `workspace_not_found` | Workspace not found for the given workspaceId |
| 500 | `start_failed` | Loop created but failed to start (normal mode) |
| 500 | `start_plan_failed` | Loop created but failed to start plan mode |
| 500 | `create_failed` | Loop creation failed |

#### POST /api/loops/title

Generate a suggested loop title from a prompt and workspace context.

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

#### GET /api/loops/:id

Get a specific loop by ID.

**Response**

Returns the loop object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |

#### PATCH /api/loops/:id

Update a loop's configuration. Cannot be used on running or starting loops — stop the loop first.

**Request Body**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Update the loop name |
| `directory` | string | Update working directory |
| `prompt` | string | Update prompt |
| `model` | object | Update model |
| `maxIterations` | number | Update max iterations |
| `maxConsecutiveErrors` | number | Update max consecutive errors |
| `activityTimeoutSeconds` | number \| null | Update activity timeout (`null` clears it to unlimited) |
| `stopPattern` | string | Update stop pattern |
| `baseBranch` | string | Update base branch |
| `useWorktree` | boolean | Update worktree usage before the loop has started |
| `clearPlanningFolder` | boolean | Update clear planning folder flag |
| `planMode` | boolean | Update plan mode flag |
| `planModeAutoReply` | boolean | Update whether planning-mode ACP questions auto-answer |
| `git` | object | Update git config (partial) |

**Response**

Returns the updated loop object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Invalid fields (e.g., empty name) |
| 400 | `invalid_json` | Request body is not valid JSON |
| 404 | `not_found` | Loop not found |
| 409 | `base_branch_immutable` | Cannot change base branch after loop has started |
| 409 | `use_worktree_immutable` | Cannot change worktree usage after loop has started |
| 500 | `update_failed` | Update operation failed |

#### PUT /api/loops/:id

Update a draft loop's configuration. Only works for loops in `draft` status.

**Request Body**

Same fields as PATCH.

**Response**

Returns the updated loop object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `not_draft` | Only draft loops can be updated via PUT |
| 400 | `validation_error` | Invalid fields (e.g., empty name) |
| 400 | `invalid_json` | Request body is not valid JSON |
| 404 | `not_found` | Loop not found |
| 409 | `base_branch_immutable` | Cannot change base branch after loop has started |
| 409 | `use_worktree_immutable` | Cannot change worktree usage after loop has started |
| 500 | `update_failed` | Update operation failed |

#### DELETE /api/loops/:id

Delete a loop.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |

---

### Loop Control

Loops are automatically started when created (unless `draft: true`). The following endpoints control loop lifecycle after creation.

#### POST /api/loops/:id/draft/start

Start a draft loop. Transitions the loop from `draft` status to either `planning` or `running`.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `planMode` | boolean | Yes | If true, start in plan mode; if false, start immediately |

**Response**

Returns the updated loop object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 400 | `not_draft` | Loop is not in draft status |
| 400 | `validation_error` | Request body must contain planMode boolean |
| 400 | `invalid_json` | Request body is not valid JSON |
| 500 | `start_failed` | Failed to start loop (normal mode) |
| 500 | `start_plan_failed` | Failed to start plan mode |

#### POST /api/loops/:id/accept

Accept a completed loop and merge its branch.

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
| 404 | `not_found` | Loop not found |
| 400 | `accept_failed` | Cannot accept (e.g., loop still running) |

#### POST /api/loops/:id/push

Push a completed loop's branch to remote for PR workflow.

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
| 404 | `not_found` | Loop not found |
| 400 | `push_failed` | Cannot push (e.g., loop still running or no remote) |

#### POST /api/loops/:id/update-branch

Update a pushed loop's branch by syncing it with the latest base branch and re-pushing if possible.

If the sync is clean, the loop remains in `pushed` status and the updated branch is pushed immediately. If conflicts are detected, Ralpher starts the conflict-resolution flow and auto-pushes when that flow completes.

**Response**

Uses the same response shape as `POST /api/loops/:id/push`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 400 | `update_branch_failed` | Cannot update the pushed branch |

#### POST /api/loops/:id/discard

Discard a loop and delete its git branch.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 400 | `discard_failed` | Cannot discard |

#### POST /api/loops/:id/purge

Permanently delete a merged or deleted loop from storage.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 400 | `purge_failed` | Cannot purge (loop not in final state) |

#### GET /api/loops/:id/ssh-session

Get the persistent SSH session linked to a loop.

**Response**

Returns the SSH session object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop or linked SSH session not found |
| 400 | `invalid_session_configuration` | Loop cannot open an SSH session with its current transport/setup |
| 500 | `ssh_session_error` | Failed to read SSH session data |

#### POST /api/loops/:id/ssh-session

Create or reuse the persistent SSH session linked to a loop.

**Response**

Returns the SSH session object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 400 | `invalid_session_configuration` | Loop cannot open an SSH session with its current transport/setup |
| 500 | `ssh_session_error` | Failed to create the SSH session |

#### GET /api/loops/:id/port-forwards

List all port forwards associated with a loop.

**Response**

Returns an array of port-forward objects.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 500 | `port_forward_error` | Failed to list port forwards |

#### POST /api/loops/:id/port-forwards

Create a new port forward for a loop's SSH-backed workspace.

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
| 404 | `not_found` | Loop not found |
| 409 | `duplicate_port_forward` | The same remote port is already being forwarded for this workspace |
| 400 | `invalid_port_forward_configuration` | The loop cannot create a port forward with its current transport/setup |
| 500 | `port_forward_error` | Failed to create the port forward |

#### DELETE /api/loops/:id/port-forwards/:forwardId

Delete a loop port forward.

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

#### POST /api/loops/:id/mark-merged

Mark a loop as externally merged and transition it to `deleted`.

This is useful when a loop branch was merged outside Ralpher (for example through a hosted pull-request flow) and you want to clean up the loop state without performing an in-app merge. In worktree-backed flows, branch/worktree cleanup remains part of the normal discard/purge lifecycle.

Only works for loops in final states (pushed, merged, completed, max_iterations, deleted).

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |
| 400 | `mark_merged_failed` | Cannot mark as merged (e.g., loop is still running) |

---

### Pending Values

Set or clear pending message and/or model for the next iteration. This is the primary way to interact with running loops.

#### POST /api/loops/:id/pending

Set pending message and/or model for next iteration. By default (`immediate: true`), running ACP-backed loops prefer staying on the active session and applying the pending values on the very next iteration without interrupting the current turn. If the backend cannot support that flow, it falls back to interrupting the current iteration. Set `immediate: false` to wait for the current iteration to complete naturally.

Works for active loops (running, waiting, planning, starting) and can also jumpstart loops in supported stopped states (completed, stopped, failed, max_iterations).

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | No | Message to queue for next iteration |
| `model` | object | No | Model change: `{ providerID, modelID }` |
| `immediate` | boolean | No | If true (default), prefer queueing on the active ACP session for running loops and fall back to interruption when unsupported. If false, wait for the current iteration to complete. |

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
| 404 | `not_found` | Loop not found |
| 409 | `not_running` | Loop is not in an active or jumpstart-eligible state |

#### DELETE /api/loops/:id/pending

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
| 404 | `not_found` | Loop not found |
| 409 | `not_running` | Loop is not in an active state |

---

### Pending Prompt (Legacy)

Modify the prompt for the next iteration while a loop is running.

#### PUT /api/loops/:id/pending-prompt

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
| 404 | `not_found` | Loop not found |
| 409 | `not_running` | Loop is not running |
| 400 | `validation_error` | Prompt is empty |

#### DELETE /api/loops/:id/pending-prompt

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
| 404 | `not_found` | Loop not found |
| 409 | `not_running` | Loop is not running |

---

### Loop Data

#### GET /api/loops/:id/diff

Get the git diff for a loop's changes.

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
| 404 | `not_found` | Loop not found |
| 400 | `no_git_branch` | No git branch was created for this loop |
| 400 | `no_worktree` | Loop has no worktree path |
| 500 | `diff_failed` | Diff operation failed |

#### GET /api/loops/:id/plan

Get the contents of `.ralph-planning/plan.md` from the loop's worktree directory.

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
| 404 | `not_found` | Loop not found |
| 400 | `no_worktree` | Loop has no worktree path |

#### GET /api/loops/:id/status-file

Get the contents of `.ralph-planning/status.md` from the loop's worktree directory.

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
| 404 | `not_found` | Loop not found |
| 400 | `no_worktree` | Loop has no worktree path |

#### GET /api/loops/:id/pull-request

Get pull-request navigation metadata for a loop.

Returns an existing GitHub pull-request URL, a compare URL for creating a pull request, or a disabled state when Ralpher cannot determine a safe destination.

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
  "disabledReason": "GitHub CLI is not available in the loop environment."
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |

#### GET /api/loops/:id/comments

Get all review comments for a loop.

**Response**

```json
{
  "success": true,
  "comments": [
    {
      "id": "uuid",
      "loopId": "loop-uuid",
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
| 404 | `not_found` | Loop not found |

---

### Plan Mode

Plan mode allows reviewing and refining a plan before execution begins.

#### POST /api/loops/:id/plan/feedback

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
| 409 | `not_running` | Loop is not running or not found |
| 400 | `not_planning` | Loop is not in planning status |
| 400 | `validation_error` | Feedback is empty |

#### POST /api/loops/:id/plan/accept

Accept the plan and either start autonomous execution or hand the work off to SSH.

The request body is optional. When omitted, Ralpher uses the default acceptance behavior.

**Request Body**

```json
{
  "mode": "start_loop"
}
```

**Response**

```json
{
  "success": true,
  "mode": "start_loop"
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
      "name": "Loop Shell",
      "workspaceId": "ws-abc123",
      "loopId": "abc-123",
      "directory": "/path/to/project",
      "remoteSessionName": "ralpher-abc-123",
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
| 409 | `not_running` | Loop is not running |
| 400 | `not_planning` | Loop is not in planning status |
| 400 | `plan_not_ready` | Plan is not ready yet (still generating) |

#### POST /api/loops/:id/plan/question/answer

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
| 400 | `not_planning` | Loop is not in planning status |
| 400 | `invalid_question_answer` | Answers do not match the question shape/options |
| 500 | `answer_plan_question_failed` | Failed to submit the answer |

#### POST /api/loops/:id/plan/discard

Discard the plan and delete the loop.

**Response**

```json
{
  "success": true
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Loop not found |

---

### Review Comments

After a loop is pushed or merged, reviewers can submit comments that the loop will address.

#### POST /api/loops/:id/address-comments

Start addressing reviewer comments. Creates a new review cycle and restarts the loop.

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
| 404 | `not_found` | Loop not found |
| 400 | `validation_error` | Comments field is required/empty |
| 409 | `already_running` | Loop is already running |

#### GET /api/loops/:id/review-history

Get the review history for a loop, including past review cycles.

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
| 404 | `not_found` | Loop not found |

#### POST /api/loops/:id/follow-up

Start a new follow-up cycle from a restartable terminal state.

For pushed or merged loops, this starts a review-feedback cycle. For other restartable loop states, it queues the message and restarts the work on the existing loop.

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
| 400 | `invalid_state` | The loop cannot accept follow-up work in its current state |
| 404 | `not_found` | Loop not found |

---

### Models

#### GET /api/models

Get available AI models for a workspace directory.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `directory` | Yes | Working directory path |
| `workspaceId` | Yes | Workspace ID for server connection |

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
| 400 | `missing_directory` | directory query parameter is required |
| 400 | `missing_workspace_id` | workspaceId query parameter is required |
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `models_failed` | Failed to retrieve models |

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

#### GET /api/preferences/log-level

Get the server log level preference.

**Response**

```json
{
  "level": "info",
  "defaultLevel": "info",
  "availableLevels": ["silly", "trace", "debug", "info", "warn", "error", "fatal"],
  "isFromEnv": false
}
```

| Field | Description |
|-------|-------------|
| `level` | Current active log level |
| `defaultLevel` | Default log level ("info") |
| `availableLevels` | All valid log level names |
| `isFromEnv` | Whether the log level was set via `RALPHER_LOG_LEVEL` environment variable |

#### PUT /api/preferences/log-level

Set the server log level. Takes effect immediately for both frontend and backend logging.

**Request Body**

```json
{
  "level": "debug"
}
```

Valid levels: `silly`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

**Response**

```json
{
  "success": true,
  "level": "debug"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Level is required |
| 400 | `invalid_level` | Invalid log level name |
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
  "publicBasePath": "/ralpher"
}
```

| Field | Description |
|-------|-------------|
| `remoteOnly` | If true, local `stdio` transport is disabled and only `ssh` transport is allowed (set via RALPHER_REMOTE_ONLY env var) |
| `publicBasePath` | Optional base path inferred from reverse-proxy `X-Forwarded-Prefix` headers |

---

### Utilities

#### GET /api/check-planning-dir

Check if a directory has a `.ralph-planning` folder with files.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `directory` | Yes | Directory path to check |
| `workspaceId` | No | Workspace ID used to disambiguate identical directory paths across different server targets |

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
| 400 | `invalid_request` | Missing `directory` query parameter |
| 404 | `workspace_not_found` | No workspace found for the given directory |
| 409 | `ambiguous_workspace` | Multiple workspaces use this directory and `workspaceId` was not provided |
| 500 | `check_failed` | Failed to check the planning directory |

---

### Workspaces

Workspaces represent project directories managed by Ralpher. Each workspace has its own server connection settings and can have multiple loops.

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

Create a new workspace. Validates that the directory exists on the remote server and is a git repository.

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
| 400 | `not_git_repo` | Directory is not a git repository |
| 404 | `directory_not_found` | Directory does not exist on the remote server |
| 409 | `duplicate_workspace` | A workspace already exists for this directory |
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

#### POST /api/workspaces/:id/archived-loops/purge

Purge all archived loops for a workspace.

Only loops in archived states for the target workspace are processed. The response includes both successful purges and per-loop failures.

**Response**

```json
{
  "success": true,
  "workspaceId": "ws-abc123",
  "totalArchived": 3,
  "purgedCount": 2,
  "purgedLoopIds": ["loop-1", "loop-2"],
  "failures": [
    {
      "loopId": "loop-3",
      "error": "Cannot purge loop in current state"
    }
  ]
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `purge_archived_failed` | Failed to purge archived loops for the workspace |

#### GET /api/workspaces/by-directory

Look up a workspace by its directory path.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `directory` | Yes | Directory path to look up |
| `workspaceId` | No | Workspace ID used to disambiguate identical directory paths across different server targets |

**Response**

Returns the workspace object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_parameter` | directory query parameter is required |
| 404 | `workspace_not_found` | No workspace found for this directory |
| 409 | `ambiguous_workspace` | Multiple workspaces use this directory and `workspaceId` was not provided |

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

Import workspace configurations from JSON. Each workspace's directory is validated on the remote server before creation. Workspaces with existing directories are skipped.

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
  "skipped": 1,
  "failed": 0,
  "details": [
    { "name": "Project A", "directory": "/path/a", "status": "created" },
    { "name": "Project B", "directory": "/path/b", "status": "skipped", "reason": "A workspace already exists for directory: /path/b" },
    { "name": "Project C", "directory": "/path/c", "status": "created" }
  ]
}
```

---

### AGENTS.md Optimization

Manage the workspace's `AGENTS.md` file, which provides AI coding agent guidelines. Ralpher can append an optimization section to improve agent performance with Ralph Loops.

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
| `analysis.isOptimized` | Whether the file already has a Ralpher optimization section |
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
  "ralpherSection": "## Agentic Workflow — Planning & Progress Tracking\n..."
}
```

| Field | Description |
|-------|-------------|
| `currentContent` | Current file contents (empty string if not found) |
| `proposedContent` | What the file would look like after optimization |
| `analysis` | Current optimization state |
| `fileExists` | Whether the file currently exists |
| `ralpherSection` | The Ralpher section that would be added or updated |

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |
| 500 | `read_failed` | Failed to read AGENTS.md |
| 500 | `preview_failed` | Failed to generate preview |

#### POST /api/workspaces/:id/agents-md/optimize

Apply the Ralpher optimization to the workspace's AGENTS.md file. If the file already has an optimization section at the current version, returns without changes.

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
    "provider": "opencode | copilot",
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

If `RALPHER_MOCK_ACP=true`, local `stdio` launches use the built-in mock ACP runtime regardless of the selected provider so end-to-end tests can exercise ACP transport behavior without an external agent CLI.

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
| `agent.provider` | string | Yes | `opencode` or `copilot` |
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

`capabilities` lists high-level runtime operations exposed by the selected provider. For example, `opencode` includes `models`, while `copilot` currently does not.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `workspace_not_found` | Workspace not found |

#### POST /api/workspaces/:id/server-settings/test

Test connection with provided settings for a workspace.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent.provider` | string | Yes | `opencode` or `copilot` |
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
| `settings.agent.provider` | string | Yes | `opencode` or `copilot` |
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

Delete database and reinitialize. This is a destructive operation that deletes all loops, workspaces, sessions, and preferences. The database is recreated fresh with all migrations applied.

**Response**

```json
{
  "success": true,
  "message": "All settings have been reset. Database recreated."
}
```

---

### Server

#### POST /api/server/kill

Terminate the server process. This is a **destructive** operation. In containerized environments (e.g., Kubernetes), this will cause the container to restart, potentially pulling an updated image.

The server sends a success response before scheduling the exit to ensure the client receives confirmation.

**Response**

```json
{
  "success": true,
  "message": "Server is shutting down. The connection will be lost."
}
```

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

Provisioning jobs create or reuse a remote workspace by cloning a repository onto a registered standalone SSH server, preparing the environment, and creating the resulting workspace in Ralpher.

#### POST /api/provisioning-jobs

Create a provisioning job.

**Request Body**

```json
{
  "name": "ralpher-demo",
  "sshServerId": "ssh-server-uuid",
  "repoUrl": "https://github.com/example/repo.git",
  "basePath": "/workspaces",
  "provider": "copilot",
  "credentialToken": "token-uuid"
}
```

`provider` defaults to `"copilot"` when omitted. `credentialToken` is optional and is used when the target SSH server requires an exchanged credential.

**Response**

Returns the created provisioning job snapshot with status `201 Created`.

```json
{
  "job": {
    "config": {
      "id": "prov-uuid",
      "name": "ralpher-demo",
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

Get all local branches for a directory.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `directory` | Yes | Directory path to check |
| `workspaceId` | No | Workspace ID used to disambiguate identical directory paths across different server targets |

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
| 400 | `missing_parameter` | directory query parameter is required |
| 400 | `not_git_repo` | Directory is not a git repository |
| 409 | `ambiguous_workspace` | Multiple workspaces use this directory and `workspaceId` was not provided |

#### GET /api/git/default-branch

Get the default branch for a git repository (e.g., "main" or "master").

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `directory` | Yes | Directory path to check |
| `workspaceId` | No | Workspace ID used to disambiguate identical directory paths across different server targets |

**Response**

```json
{
  "defaultBranch": "main"
}
```

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_parameter` | directory query parameter is required |
| 400 | `not_git_repo` | Directory is not a git repository |
| 409 | `ambiguous_workspace` | Multiple workspaces use this directory and `workspaceId` was not provided |
| 500 | `git_error` | Failed to retrieve default branch |

---

### Events (WebSocket)

#### WS /api/ws

WebSocket endpoint for real-time event streaming. Supports optional loop and SSH-session filtering.

**Query Parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `loopId` | No | Filter events to a specific loop |
| `sshSessionId` | No | Filter SSH session events to a specific workspace-backed SSH session |
| `sshServerSessionId` | No | Filter SSH session events to a specific standalone SSH server session |

**Connection URL Examples**

```
ws://localhost:3000/api/ws              # All events
ws://localhost:3000/api/ws?loopId=abc   # Events for loop "abc" only
ws://localhost:3000/api/ws?sshSessionId=ssh-123
wss://example.com/api/ws                # Secure WebSocket
```

**Connection Message**

Upon successful connection, the server sends a confirmation:

```json
{"type":"connected","loopId":null}
```

If `loopId` was specified:

```json
{"type":"connected","loopId":"abc-123"}
```

**Event Types**

Each event is a JSON object with a `type` field:

| Event Type | Description |
|------------|-------------|
| `loop.created` | New loop was created |
| `loop.started` | Loop execution started |
| `loop.iteration.start` | Iteration began |
| `loop.iteration.end` | Iteration completed |
| `loop.message` | AI message received |
| `loop.tool_call` | Tool was invoked |
| `loop.progress` | Streaming text delta |
| `loop.log` | Application log entry |
| `loop.git.commit` | Git commit made |
| `loop.completed` | Loop finished successfully |
| `loop.ssh_handoff` | Plan was accepted by opening an SSH session instead of starting autonomous execution |
| `loop.stopped` | Loop was stopped manually |
| `loop.session_aborted` | AI session was aborted |
| `loop.error` | Error occurred |
| `loop.deleted` | Loop was deleted |
| `loop.accepted` | Branch was merged |
| `loop.pushed` | Branch was pushed to remote |
| `loop.discarded` | Branch was deleted |
| `loop.sync.started` | Branch sync with base started |
| `loop.sync.clean` | Branch sync completed cleanly |
| `loop.sync.conflicts` | Merge conflicts detected during sync |
| `loop.plan.ready` | Plan is ready for review (planning mode) |
| `loop.plan.feedback` | Feedback was sent on plan |
| `loop.plan.accepted` | Plan was accepted, execution starting |
| `loop.plan.discarded` | Plan was discarded, loop deleted |
| `loop.todo.updated` | TODO list was updated |
| `loop.pending.updated` | Pending message/model was updated |
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
{"type":"loop.iteration.start","loopId":"abc-123","iteration":3,"timestamp":"2026-01-20T10:15:00.000Z"}

{"type":"loop.log","loopId":"abc-123","id":"log-1","level":"info","message":"Sending prompt to AI","timestamp":"2026-01-20T10:15:01.000Z"}

{"type":"loop.tool_call","loopId":"abc-123","iteration":3,"tool":{"id":"tc-1","name":"Write","input":{"path":"/src/foo.ts"},"status":"running"},"timestamp":"2026-01-20T10:15:05.000Z"}

{"type":"loop.plan.ready","loopId":"abc-123","planContent":"# Plan\n\n## Goals\n...","timestamp":"2026-01-20T10:16:00.000Z"}

{"type":"loop.todo.updated","loopId":"abc-123","todos":[{"id":"1","content":"Implement feature","status":"in_progress"}],"timestamp":"2026-01-20T10:17:00.000Z"}
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

Active loop port forwards are exposed through browser-facing proxy routes:

- `GET /loop/:loopId/port/:forwardId`
- `GET /loop/:loopId/port/:forwardId/*`
- WebSocket upgrades on the same paths

These routes proxy HTTP and WebSocket traffic to the loop's forwarded remote service and rewrite absolute paths/redirects so browser apps can run under the loop-scoped prefix.

---

## Data Types

### Loop Status

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

Log levels used in `loop.log` events:

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
| `continue` | Iteration complete, loop continues |
| `complete` | Stop pattern matched, loop complete |
| `error` | Error occurred during iteration |
| `plan_ready` | Plan created and ready for review (planning mode) |

### Commit Message Format

Ralpher generates commit messages following the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification:

```
type: description
type(scope): description
```

Ralpher defaults to scope-less commit messages. When `git.commitScope` is set, it should name a meaningful module, section, or topic touched by the change. Generic placeholder values such as `"ralph"` are omitted. Valid types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`, `perf`, `revert`.

Examples:
- `feat: add JWT authentication endpoint`
- `fix(auth): handle token expiration edge case`
- `chore(api): update loop creation request docs`

### TODO Item

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `content` | string | TODO item description |
| `status` | string | "pending", "in_progress", "completed", or "cancelled" |
| `priority` | string | "high", "medium", or "low" |

---

## Examples

### Create a Loop

Loops are automatically started upon creation (unless `draft: true`).

```bash
# Create a loop (starts automatically)
curl -X POST http://localhost:3000/api/loops \
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
wscat -c ws://localhost:3000/api/ws?loopId=abc-123
```

### Create a Draft Loop

Draft loops are saved without starting. You can edit them before starting.

```bash
# Create a draft loop
curl -X POST http://localhost:3000/api/loops \
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
curl -X PUT http://localhost:3000/api/loops/abc-123 \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Implement JWT-based authentication with refresh tokens"
  }'

# Start the draft
curl -X POST http://localhost:3000/api/loops/abc-123/draft/start \
  -H "Content-Type: application/json" \
  -d '{"planMode": false}'
```

### Create a Loop with Plan Mode

Plan mode lets you review and refine the plan before execution.

```bash
# Create a loop in plan mode
curl -X POST http://localhost:3000/api/loops \
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
curl -X POST http://localhost:3000/api/loops/abc-123/plan/feedback \
  -H "Content-Type: application/json" \
  -d '{"feedback": "Also consider adding error handling for token expiration"}'

# Accept the plan and start execution
curl -X POST http://localhost:3000/api/loops/abc-123/plan/accept
```

### Modify Next Iteration Prompt

```bash
# While loop is running, set a pending prompt
curl -X PUT http://localhost:3000/api/loops/abc-123/pending-prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Continue, but also add unit tests for the auth module"}'
```

### Accept Completed Loop

```bash
# After loop completes, review and accept
curl -X POST http://localhost:3000/api/loops/abc-123/accept
# Response: {"success":true,"mergeCommit":"def456..."}
```

### Address Reviewer Comments

After pushing a loop, you can address reviewer comments:

```bash
# Push the loop first
curl -X POST http://localhost:3000/api/loops/abc-123/push
# Response: {"success":true,"remoteBranch":"add-dark-mode-toggle-a1b2c3d","syncStatus":"clean"}

# Later, address reviewer comments
curl -X POST http://localhost:3000/api/loops/abc-123/address-comments \
  -H "Content-Type: application/json" \
  -d '{"comments": "Please fix the type errors and add error handling"}'
# Response: {"success":true,"reviewCycle":1,"branch":"add-dark-mode-toggle-a1b2c3d-review-1"}

# Get review history
curl http://localhost:3000/api/loops/abc-123/review-history
# Response: {"success":true,"history":{"addressable":true,"completionAction":"push","reviewCycles":1,"reviewBranches":[]}}
```
