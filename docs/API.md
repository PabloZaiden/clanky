# Clanky HTTP and CLI reference

This document describes the REST API for the Clanky Task Management System.

## Base URL

```
http://localhost:3000/api
```

The port can be configured via the `CLANKY_PORT` environment variable, and the bind host can be configured via `CLANKY_HOST`.

## Message attachments

A message can include up to 20 files of any type. Each file can be up to
20 MiB. The combined
attachments for one provider turn, including queued messages and images steered
into an active turn, can total up to 60 MiB.

PNG, JPEG, WebP and GIF keep their inline image delivery. All other files,
including TXT, Markdown and PDF, are copied unchanged to the conversation's
execution host. The agent receives absolute file paths, not extracted text,
embedded documents or `attachment://` URIs. A model must use its own filesystem
tools to inspect them. See [Conversation attachments](attachments.md).

Each `attachments` entry retains `{ id, filename, mimeType, data, size }`;
`data` is canonical padded base64 and `size` is its decoded byte count.
Missing/empty MIME defaults to `application/octet-stream`. Empty non-image
files are accepted. Browser file chips download the saved original, not a
potentially edited execution-host copy.

## Chat Trash

`DELETE /api/chats/:id` moves standalone chats to recoverable Trash rather than
destroying their history or worktrees. Use `GET /api/trash`,
`POST /api/trash/:id/restore`, `DELETE /api/trash/:id` and `DELETE /api/trash`
to list, restore, permanently delete or empty it. Retention is 30 days, checked
at startup and daily. Tasks and their conversations are unchanged.
See [Chat Trash](chat-trash.md) for pagination, cleanup and recovery semantics.

## Authentication

Browser sessions use passkeys. CLI and automation clients can use device
credentials or API keys. This document covers Clanky domain endpoints; the
framework-owned authentication and health endpoints are listed separately
where they affect integration.

`clanky auth` uses the framework device flow, `clanky api` sends authenticated
REST calls with selected framework credentials, `clanky ws` opens an
authenticated JSON-lines websocket session against `/api/ws`, `clanky schema`
exposes discoverability metadata for catalogued Clanky endpoints, and
`clanky update` checks or installs published Clanky release binaries from
GitHub Releases.

Updates use the latest stable release by default. Pass `--pre-release` to
select the latest published prerelease only when it is newer than the latest
stable release; otherwise, the stable release is selected. `--check` reports
the selected update without replacing the installed binary. `--version VERSION`
selects that exact release and takes precedence over `--pre-release`.

## Route security and discovery metadata

Normal private REST routes require an authenticated user and enforce
same-origin protection for browser mutations. Automatic workspace restart,
global worker updates, database reset, and terminal-task purge are owner-only.
Preview and terminal WebSocket upgrades require an authenticated user and
always enforce same-origin checks.

Use `clanky api` to list the routes exposed by the running server and
`clanky schema <endpoint>` to inspect a route's request, response, and CLI
metadata. Public routes are exceptional and are identified explicitly in the
route reference.

## Transcript snapshots

Chat, task and agent-run `GET .../:id/snapshot` responses default to the
latest 100 non-empty assistant responses. Without `view=conversation`, they
accept mutually exclusive transcript-window options:

| Parameter | Meaning |
| --- | --- |
| `before` | Read the next older page using `transcript.nextCursor`. This is history, not a new live baseline. |
| `since` | Refresh the loaded window inclusively from its oldest response cursor, including newer content. |
| `full=1` | Read all retained transcript history. |

`transcript.position` contains the authoritative content `epoch` and
`revision`, including active output ahead of its persistence checkpoint.
Content deltas delivered through [realtime interests](#ws-apiws) include
`streamPosition` with `baseRevision` and `revision`.
Buffer concurrent deltas during a baseline read, discard covered updates,
and apply only contiguous successors. An epoch change or missing predecessor
requires a new baseline; do not compare opaque epochs or use ETags as live
cursors. Reconnection does not replay transient commands.
Terminal, preview and Mesh sockets remain separate raw transports.

## Compact reads and literal conversations

Catalogued JSON operations use the same endpoints, authorization and execution
host with an optional `view=compact`. Requests without `view` keep their
existing response shape. Credential-management and raw/binary transports are
not assistant read operations; inspect `clanky schema <endpoint> --method GET`
for the supported options.

All catalogued collection reads share these parameters, including read-policy
`POST` discovery operations:

| Parameter | Meaning |
| --- | --- |
| `view=compact` | Small metadata, rather than expanded runtime state or content. |
| `limit` | Maximum rows or content parts, 1–100; default 20. |
| `maxBytes` | Successful JSON response budget in UTF-8 bytes, 1,024–16,384; default 4,096. |
| `cursor` | Opaque continuation from the preceding page. |
| `section` | Named content/collection section supported by this resource. |
| `item` | Stable item reference returned in a row's `details`. |

Collections return `{ "items": [...], "nextCursor": "..." | null }`, optionally
with small `context` such as the resolved directory, activity coverage or
source truncation. This applies to chats, tasks, workspaces, execution hosts,
SSH servers, agents/runs, terminals, provisioning/logs, models, previews,
review comments, interactions, and exposed file/Git collections. File trees return flat entry
pages; `loadOnExpand` still identifies deferred directories. Objects containing
multiple collections label rows with `collection` and the matching detail
section. `nextCursor: null` completes the exposed source, not data that the
underlying source explicitly reports as truncated or deferred.

Chat/task/run collection and item metadata are read directly from storage
without loading their transcripts or expanded harness. Their stable order is
descending creation time, then ID. Metadata includes identity, status, source,
model and actionable input counts when available. Unreadable persisted state
is marked `stateUnavailable`, not reported as an empty healthy state.

Compact **chat/task collections** additionally accept:

| Parameter | Meaning |
| --- | --- |
| `workspaceId` | Filter by workspace ID. |
| `name` | Exact name, using SQLite's case-insensitive comparison, not fuzzy search. |
| `status` | Exact public status. |
| `needsInput=true` or `false` | Required intervention, not optional completed-work actions. |
| `order=created` or `activity` | Descending creation (default) or actual activity, then ID. |

Activity order uses the persisted work-activity timestamp, falling back to
creation; configuration edits are not activity. Metadata includes
`lastActivityAt`, `lastUserMessageAt` and `interventionReasons` (`question`,
`permission`, `plan_approval`). A ready task plan in planning with manual
approval required counts as input. Available accept/push actions on completed
tasks are separate `availableActions`, not required intervention.
`needsInput=true` also includes unavailable persisted state, explicitly marked,
so callers do not mistake missing state for proof that nothing needs attention.
These new selectors apply to compact collection reads; requests without the
compact view retain their existing behavior.

Continue the **same read operation**, retaining its filters, view, section and
public request body. `limit` and `maxBytes` may change between pages.
Authorization and selected-host resolution run on every request. Cursors
identify a source; they are not authorization capabilities. An incompatible
cursor returns `read_cursor_invalid` (400); changed collection membership or
selected content returns `read_cursor_stale` (409). Restart that read without
its cursor, not a mutation.

Small item reads return metadata with `details`. Follow the reference to read
its original content. Named sections include `questions`, `permissions`,
`inputs`, `activity`, `activities`, `comments`, `logs`, `prompt`, `content`, `output`, `plan` and `diff`; inspect
the resource's contract and references for applicable sections. Missing
sections/items are explicit 400 errors. Oversized metadata is marked
`read_item_requires_details`, never clipped into invalid JSON.

Selected details and long content use the same page envelope:

```json
{
  "items": [
    { "path": ["questions", 0, "text"], "value": "Literal content...", "offset": 0, "complete": false }
  ],
  "nextCursor": "..."
}
```

String path segments are object keys; numeric segments are array indices, so
numeric-looking object keys remain distinguishable. Empty objects/arrays are
preserved as values. Concatenate string chunks at their offsets; `complete`
marks the last chunk of that value. **Offsets count UTF-16 code units, whereas
budgets count UTF-8 bytes of serialized JSON.** Chunks never split a surrogate
pair. `section=details` retrieves the original response/item without compact
field projection.

Chat, task and agent-run `/snapshot` endpoints also accept
`view=conversation`. They return chronological literal user/assistant text:
`{ id, role, timestamp, content, offset, complete }`, with minimal optional
delivery/attachment-count markers. Actual question/answer messages are
included; tool calls, reasoning, logs, harness/session/config and attachment
binaries are not. This is not a generated summary. Queued or unconfirmed
answers are not presented as delivered. Message membership and the selected
long message are revision-checked; unrelated tool/log updates do not invalidate
conversation chunks. Existing `before`/`full` snapshots remain unchanged and
cannot be combined with this view.

Conversation reads accept `range=earliest` (default) or `range=latest`.
Latest selects the final `limit` human-readable messages directly, then delivers
that chronological window through the ordinary byte-bounded pages and offsets.
Its `context` includes `{ "range": "latest", "omittedEarlierMessages": N }`.
A long selected message starts at its beginning and may require continuation;
this is not clipped tail text. Keep **range and limit unchanged** when
continuing latest reads; `maxBytes` can still change. A null cursor completes
the selected window, not omitted earlier history. Membership or selected-message
changes retain the existing stale-cursor behavior. For example:

```text
GET /api/chats?view=compact&order=activity&limit=5
GET /api/tasks?view=compact&needsInput=true
GET /api/chats/CHAT_ID/snapshot?view=conversation&range=latest&limit=6
```

Writes accept only `view=compact` and `maxBytes`, returning a compact receipt
with the original HTTP outcome. They cannot be paged. A
`read_result_requires_targeted_read` receipt means data was omitted, not that
the operation failed: inspect the target through a read or the UI and **do not
repeat the write** to retrieve its output.

## CLI discovery helpers

The standalone `clanky` binary exposes the server and API discovery directly:

```bash
# Start the embedded local server
clanky serve

# Print the installed CLI version
clanky version

# Check whether a newer published binary is available
clanky update --check

# Check for a newer prerelease, falling back to stable when none is newer
clanky update --check --pre-release

# Update the installed release binaries in place
clanky update

# Install the newer prerelease when one is available
clanky update --pre-release

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

## Live previews from the CLI

```bash
clanky preview --workspace "my-workspace" --port 3000
clanky preview --server "my-server" --port 3000

# HTTPS development app with a self-signed certificate:
clanky preview --workspace "my-workspace" --port 8443 --https

# Preserve absolute https://localhost:8443 links on the CLI machine:
clanky preview --workspace "my-workspace" --port 8443 --https --local-port 8443

# Use a browser-trusted local development certificate instead of generating one:
clanky preview --workspace "my-workspace" --port 8443 --https \
  --tls-cert ./localhost.pem --tls-key ./localhost-key.pem
```

Keep the CLI running while using the printed preview URL. The destination port
belongs to the selected execution host, not necessarily the Clanky controller.
Workspace previews support local, SSH, and Mesh execution hosts; direct server
previews support local and Mesh hosts. HTTP is the default. `--remote-host`
defaults to `localhost`; `--host` selects the CLI listener address and defaults
to `localhost`. `--path` selects the initial page and `--open` opens the preview
in your browser.

`--https` enables HTTPS to the application **and** on the local preview,
including WSS forwarding. Preview upstream application certificates are always
accepted without certificate verification, including self-signed certificates.
This applies only to the preview's HTTPS and WSS connections; certificate
validation for the authenticated connection to Clanky and Mesh transport is
unchanged.

Without `--tls-cert` and `--tls-key`, HTTPS previews generate and reuse a
self-signed local certificate covering `localhost`, `127.0.0.1`, `::1`, and
the listener hostname. Its private identity is stored with restrictive
permissions under `preview-tls/` in the **CLI machine's** Clanky data directory
(`CLANKY_DATA_DIR`, or `~/.clanky` by default). Concurrent previews reuse the
same identity for the same hostnames. An expired or damaged saved identity fails
explicitly; remove that identity file to generate a replacement, or supply a
valid certificate/key pair. Replacing it requires trusting the new certificate
again.

The browser must accept the local self-signed certificate before navigation and
secure WebSockets can work. Clanky does not modify browser or operating-system
trust stores. For warning-free local HTTPS, supply a certificate/key pair from
a development CA already trusted by that browser (for example, `mkcert`).
`--tls-cert` and `--tls-key` must be supplied together and require `--https`;
they configure only the CLI listener, not upstream trust.

The local port is random unless `--local-port` is supplied. Relative URLs work
on that port, and absolute redirects to the registered application or tunnel
origin are rewritten to the preview origin. Absolute URLs embedded in HTML,
JavaScript, or app configuration are not rewritten: for
`https://localhost:8443/...`, use `--local-port 8443` on a CLI machine where
that address and port are free, or configure the application's public origin
to match the printed preview URL. If the app and CLI run on the same machine
and bind the same address, they cannot both listen on that port. Links to
other hosts or ports are not implicitly proxied.

`--host 0.0.0.0` exposes the preview to the local network and prints a warning.
For HTTPS on another device, supply a certificate covering the LAN hostname or
IP and trusted by that device; the generated localhost certificate does not
cover every LAN address.

The authenticated `/api/previews/bridge` `hello` optionally carries
`protocol: "http" | "https"` (default `"http"`). HTTPS upstream certificates
are always accepted. `localUrl` advertises the actual browser-facing origin,
including its scheme. Listener keys stay on the CLI machine and are never
sent over the bridge. HTTPS options do not change `clanky code`, which keeps
its existing HTTP loopback listener.

## VS Code web from the CLI

```bash
clanky code "my-workspace"
clanky code "my-workspace" --chat "chat-name-or-id"
clanky code "my-workspace" --task "task-name-or-id" --open

# Explicit consent when the installed VS Code CLI requires its server license:
clanky code "my-workspace" --accept-server-license-terms --open
```

Workspace references accept an ID or exact name. `--chat` and `--task` are
mutually exclusive and are resolved only within that workspace. Duplicate
names require an ID. Chat/task selectors open their existing effective working
directory, including managed worktrees and task-linked chats; a missing worktree fails without
creating it or starting an agent.

The selected workspace host (local, SSH or Mesh) must already have a `code`
CLI supporting `serve-web`, `--port 0`, `--connection-token-file`, and
`--default-folder`. Some Remote SSH/Codespaces `code` commands only launch an
existing editor and cannot serve one. Clanky does not install or replace VS
Code and does not use Microsoft's tunnel service. POSIX hosts also need
`bash`, `ps`, `awk`, and `sort` for the session's process ownership supervision,
including inherited terminals that change process groups. Windows uses the native
process-tree termination path.

The command starts a token-protected VS Code listener on that host's
`127.0.0.1` and creates a normal Clanky workspace preview. It prints a
`http://127.0.0.1:PORT/` URL and its `http://localhost:PORT/` equivalent on
the **CLI machine**, not a public URL. The preview listens on IPv4 loopback
and, when the operating system supports it, IPv6 loopback at the same port.
Opening `http://[::1]:PORT/` redirects to `localhost` because VS Code's
generated workbench authority does not support IPv6 literals; `localhost`
can connect over either address family. If IPv6 is unavailable, the CLI
reports that it is listening on IPv4 only. VS Code itself and the preview's internal
forwarding use `127.0.0.1` explicitly, so `localhost` resolving to `::1`
cannot redirect the internal connection to a different address family.
`--open` launches that machine's browser; without a graphical environment,
open the printed URL manually on the same machine. The local listener rejects
foreign hosts, mismatched origins (including between loopback aliases), and
cross-site subresource requests. VS Code credentials
are held in the session, not printed in the URL or persisted in preview state.
Use existing Clanky device profiles or `CLANKY_BASE_URL`/`CLANKY_API_KEY`.
`--base-url URL` is also accepted.

Keep the CLI running. Ctrl+C, closing the preview in Clanky, disconnecting the
bridge, or stopping the Clanky server stops that session's VS Code process
tree and removes its temporary data. Settings/extensions installed into that
session's server data are temporary. Sessions are not shared or adopted from
other VS Code instances. A lost execution host can prevent immediate cleanup;
such failures are reported rather than claiming a confirmed shutdown.

VS Code resource ownership is saved before its private directory, credentials,
or process is created. After controller loss, startup retries cleanup on the
original execution host, including removal of that session's temporary data.
It never sweeps the host's temporary directory or adopts other VS Code instances.
If cleanup cannot be confirmed, the preview remains listed as `closing` with an
error, not as a usable editor. Retry `DELETE /api/previews/:previewId` when the
host is available; the next controller restart also retries. Workspace deletion
waits for in-progress preview launches and requires its previews to close first
so their cleanup records are not discarded.
Execution-target edits also close existing previews before changing the original
host metadata; unavailable cleanup prevents that edit. Registered SSH server
address, port, username changes and deletion follow the same rule, retaining
the original metadata and credentials if cleanup fails. Preview launches are
serialized with those mutations. Relay-backed cleanup is
retried after the controller connection is authenticated and worker authorization
has synchronized.
Pre-upgrade previews have no recoverable ownership metadata: their stale bridges
are removed, but Clanky cannot safely infer or delete their old host resources.
On Windows, normal shutdown uses native process-tree termination; after abrupt
controller loss, resources remain pending when termination cannot be confirmed.

The first launch may download VS Code server components and needs the host's
network access and supported system libraries. Startup waits for the editor
to be served, not just a listening port, with a two-minute startup deadline.
If license consent is needed, review
[Microsoft's server terms](https://aka.ms/vscode-server-license) and explicitly
pass `--accept-server-license-terms`; Clanky does not accept them silently.
This integrates your installed VS Code for individual development, not a
shared hosted IDE offering.

The authenticated raw `/api/previews/bridge` accepts a `hello` with an optional
`code: { chat?, task?, acceptServerLicenseTerms }`. Code starts require a
workspace target, `remoteHost: "127.0.0.1"`, `remotePort: 0`, and a loopback
local URL at `/`. A successful `ready` additionally includes
`code: { directory, remotePort }`. Errors include a stable `code` and safe
`error` message. A `{ type: "close" }` request waits for cleanup before the
bridge closes. HTTP responses stream through the preview with per-request
consumption acknowledgements and a bounded receive window, so slow readers pause
upstream rather than overflowing a response buffer. Bridge clients opt in with
`request.start.responseFlowControl: true` and acknowledge consumed bytes with
`{ type: "response.ack", streamId, bytes }`. The receive window is 256 KiB;
30 seconds without consumption progress cancels the upstream response.
Cancelling a local request sends `{ type: "request.cancel", streamId }`.

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

Agent sessions use the adapter selected for the workspace; ACP additionally
selects a harness preset. A workspace can
run locally, over SSH, or through a Mesh worker. Git, file, and command
operations run on that workspace's execution host, while the API and
application data remain on the controller.

See [harness adapters](harnesses.md) for native runtime requirements, scoped
activity/Stop and queued-input steering. Native execution requires a local host
or an end-to-end Mesh v6 path; direct SSH remains ACP-only.

`workspace.directory` is the initial navigation directory, not a filesystem
sandbox. File operations may access parent paths, absolute paths and alternate
start directories on the selected host, subject to the execution account's
filesystem permissions. Access outside the initial directory is intentional
and an accepted product risk; authentication, workspace ownership and
execution-host authorization still apply.

### Automatic chat names

Workspace chats created without a name start with `<workspace name> - <number>`.
After the first user message is accepted by the backend, Clanky generates a
short name asynchronously using the configured helper model. This applies to
ACP and native chats and does not delay the conversation. The generated name
is persisted only while the chat still has one user message and retains its
provisional name; manually chosen names are preserved. If generation fails,
the provisional name remains and the failure is logged.

### Chat worktree branch names

`POST /api/chats` accepts the optional `useChatNameAsBranch` boolean. When it
is `true` and `useWorktree` is enabled, the working branch is the sanitized
chat name, without the usual `chat-` prefix or chat-ID suffix. Sanitization
lowercases the name, replaces characters outside `a-z`, `0-9`, and `-` with
hyphens, collapses and trims hyphens, and limits the result to 40 characters;
an empty result becomes `unnamed`. Omitted or `false` keeps the existing
`chat-<sanitized-name>-<first-eight-chat-id-characters>` format. The named
**New Chat** form exposes this option only for Git workspaces with **Use
worktree** enabled; Quick Chat and non-worktree creation remain unchanged.
If the resulting branch is already checked out or claimed by another chat in
the same repository, creation returns HTTP 409 with
`chat_worktree_branch_conflict` before persisting the new chat. A free existing
branch can still be attached to the worktree.

`POST /api/chats` also accepts the optional
`useSelectedBranchForWorktree` boolean. When `true`, `useWorktree` must be
enabled, `baseBranch` must select a branch, and `useChatNameAsBranch` must not
be enabled. The worktree uses that selected branch directly instead of creating
a chat-specific branch. If `baseBranch` is a remote-tracking reference such as
`origin/feature`, Clanky creates or reuses the corresponding local branch
`feature` tracking `origin/feature`; a local branch with a different upstream
is rejected. The option is omitted or `false` by default, preserving the
existing new-branch behavior. Multiple worktrees may use the same local branch,
but they share one Git reference: commits in either worktree advance that
branch for all of them. Deleting a chat removes its managed worktree, not the
shared branch. This option works with ACP and native providers alike; the
workspace's execution host must advertise managed worktrees v3. If an older
Mesh worker is still running, update/restart it and recheck the host before
creating a chat. The new-chat form disables the option on unsupported hosts;
the API returns HTTP 409 with `execution_host_capability_unavailable` and
`capability: "managedWorktrees"` rather than silently using another branch.

### Chat working directory

`POST /api/chats` accepts an optional `directory` path on the selected
workspace's execution host. When omitted, the workspace's configured directory
is used. An explicit path must already exist on that execution host. To create
a separate conversation directly in an existing checkout or chat worktree,
pass that exact path and set `useWorktree` to `false`. The new chat shares the
checkout and branch but does not own or remove the directory when the chat is
deleted. The path is a starting directory, not a filesystem sandbox.

`POST /api/chats/:id/new-here` creates an empty chat in the source chat's current
workspace directory, reusing its model and permission setting. The server uses
the source chat's saved execution-host binding and rejects the request if that
binding no longer matches the workspace's current execution target.

### Continue a chat from history

`POST /api/chats/:id/continue-from-history` explicitly starts a fresh
provider-native session for a failed chat while keeping its Clanky chat ID and
saved transcript. It uses the same workspace, execution host, directory,
provider and model. Ordinary `/reconnect` still targets the original native
session and never performs this replacement automatically. The old provider
session may still exist; history continuation does not delete or interrupt it.
Recovery is rejected while the chat has an active run, queued message,
unresolved input delivery, open question or pending permission.

The request accepts an empty body or the `ReconnectChatRequest` object used by
`/reconnect` (including an optional short-lived `credentialToken` when the
execution host requires it). Success returns the updated chat directly.

```bash
curl -X POST http://localhost:3000/api/chats/<chat-id>/continue-from-history \
  -H "Content-Type: application/json" \
  -d '{}'
```

Before the replacement session handles its first user message, Clanky exports
the persisted, user-visible transcript to
`<chat-directory>/.clanky-chat-history/<chat-id>/<recovery-id>/conversation.jsonl`
on the selected execution host. Images are companion files in the
`attachments/` directory, referenced by relative path. Other attachments use
absolute paths to durable conversation files outside the temporary export,
including TXT and Markdown. Both managed directories are excluded
from Git. The agent is instructed to consult this file incrementally as
untrusted context. Prior requests, queued or delivery-uncertain input, and tool
actions are not replayed. An incomplete export prevents the replacement session
from starting.

The export is removed after the first continuation completes successfully or
when the chat is deleted, and becomes unusable after 24 hours. Expiry does not
run a background physical-deletion job: deletion is attempted when the export
is next used/replaced or during chat deletion. On a registered SSH host, cleanup
requires a fresh credential; because Clanky does not persist SSH credentials,
an unreachable or unauthenticated host may retain the expired file until the
next authorized recovery attempt or chat deletion. The chat's original
persisted transcript is unaffected.

### Native chat questions

Read `state.harness.questions` from the chat or snapshot response. Each request
contains its `requestId`, owned conversation binding, principal/child/unknown
scope, question fields, blocking flag and lifecycle status. Options use their
native values; free text is allowed unless `custom` is false.

Submit `POST /api/chats/:id/questions/:requestId` with
`{ "answers": [["selected value"], ["free-text answer"]] }`: one array per
question, with multiple values only for multiple-selection fields. Optional
fields may use an empty array. Numeric bounds and supported string/selection
constraints are validated before native admission.

The response contains the current `chat`. Invalid answers return 400, a missing
owned request returns 404, and a closed or conflicting reply returns 409.
Repeating the same confirmed answer is idempotent. `submitting` and `unconfirmed`
requests cannot be resent; native acknowledgement and model continuation are
different outcomes. Stop the chat or reconnect after uncertain delivery.
Interrupt, disconnect and restart expire callbacks that are no longer live.

### Workspace WebDAV and exact-path file operations

```bash
clanky workspace webdav <ID_OR_NAME> [--read-only] [--local-port PORT] [--tls-cert FILE --tls-key FILE]
```

This foreground CLI command runs a DAV listener on `127.0.0.1`, with a random
per-run Basic password. The OS mounts the printed URL; the CLI forwards file
operations through authenticated controller APIs and the selected local, SSH
or Mesh executor. It does not forward the native client's Authorization header
upstream or send controller/profile credentials as DAV login credentials.
Controller HTTPS is required outside loopback; redirects are rejected, even
during device-token refresh. Profiles refresh during use without replaying a
consumed PUT body or retrying unknown mutation outcomes.

Read/write is the default. `--read-only` blocks PUT, MKCOL, MOVE, COPY, DELETE,
PROPPATCH, LOCK and UNLOCK at this listener; it does not revoke independent
API, agent or host access. No public/LAN bind, daemon, automatic mounting or
filesystem sandbox is provided. Unexpected Host authorities and cross-origin
browser requests are rejected. Optional `--tls-cert FILE --tls-key FILE`
must be supplied together and use a certificate trusted by the native client
for the local hostname/address. Clanky never installs a certificate or changes
the OS's authentication policy.

Start the bridge on the client computer and keep it running while mounted:

```bash
clanky workspace webdav my-workspace
# Or expose a read-only volume:
clanky workspace webdav my-workspace --read-only
```

On macOS, Finder's **Go > Connect to Server** (`Cmd+K`) accepts the printed URL
and temporary local username/password. To mount into a directory from a terminal:

```bash
mkdir -p "$HOME/Clanky"
mount_webdav -i '<printed URL>' "$HOME/Clanky"
# Unmount before stopping the bridge with Ctrl+C:
umount "$HOME/Clanky"
```

Clanky does not install FUSE or other mounting software. `Ctrl+C` closes its
local listener; WebDAV does not provide a complete POSIX filesystem or offline
synchronization.

URLs represent absolute paths on the selected host, percent-encoding each
component: `/home/user/project/` for POSIX, `/C%3A/project/` for a Windows
drive, and `/UNC/server/share/project/` for UNC paths. The initial URL is the
workspace directory. To access another directory, mount its URL under the
same endpoint; native clients may not allow `..` above a mounted volume.
Existing host symlink semantics apply. Atomic replacement of a destination
file, including a file symlink, uses rename semantics like explorer binary
uploads. Neither credentials stored in host files nor cached native-client
downloads are hidden or revoked by this bridge.

The controller exposes these user-owned endpoints for both workspace and
standalone execution-host adapters:

| Method | Workspace path | Purpose |
| --- | --- | --- |
| POST | `/api/workspaces/:id/files/filesystem` | JSON filesystem command. |
| GET, HEAD, PUT | `/api/workspaces/:id/files/filesystem/content?path=...` | Binary stream/metadata or staged binary replacement. |
| POST | `/api/execution-hosts/:kind/:id/files/filesystem` | Same commands, with host authorization/credentials. |
| GET, HEAD, PUT | `/api/execution-hosts/:kind/:id/files/filesystem/content?path=...` | Same exact-path binary operations on a standalone host. |

API keys/device tokens require `clanky:files` or `*`. Browser mutations retain
framework same-origin protection. Standalone SSH adapters require the existing
`x-clanky-ssh-credential-token`; no password is accepted by these contracts.
Paths are nonempty, NUL-free strings of at most 16,384 characters and are not
trimmed. Relative API paths resolve from the adapter's initial directory;
valid absolute/parent paths are deliberately unrestricted by that directory.

Commands use an `operation` discriminator: `info`, `stat`, `list`, `mkdir`,
`delete`, `move`, `copy`, `lock`, `refreshLock`, `unlock`, or `releaseLocks`.
`info` returns `directory`, `pathStyle`, an opaque `target` fingerprint and
`commandExecution`. `stat` accepts `hash: true` for a content-hash ETag.
Other results contain applicable `entry`, `entries`, `locks`, `lock`, `created`
or `overwritten` fields. MOVE/COPY accept `destination`, `overwrite` and
`depth: "0" | "infinity"`; MOVE always uses infinity. Inspect the route's
schema for the complete lock/precondition contract.

Send `x-clanky-file-target` with the `info.target` value to reject changed
execution targets with `409 file_system_target_changed`. A bridge pins this
value rather than automatically rebinding. Commands take optional `conditions`
with `ifMatch`, `ifNoneMatch` and parsed DAV `davIf` lists; streamed PUT takes
the same JSON object in `x-clanky-file-conditions`. Failed/stale validators
return `412 file_system_precondition_failed`; missing lock tokens return
`423 file_system_locked`. GET is streamed and may be chunked; its
`x-clanky-download-size` header and HEAD's `Content-Length` expose file size.

PUT and COPY stage on the destination filesystem and rename only after
completion; failures remove staging without pre-deleting an existing file.
MKCOL/COPY require `commandExecution` and use existing host commands, bounded
by a 120-second deadline, not new worker RPCs. Directory replacement and
cross-filesystem MOVE are unsupported. Filesystem-root deletion/move and
recursive copy/move into the source itself are rejected. External host tools
can still race operations: DAV locks are not host-wide locks or filesystem CAS.
Recursive DELETE can fail after removing some children; a failed response is
not a rollback guarantee. Inspect authoritative state after uncertain outcomes.
The current Bun/framework controller limits streamed uploads to 128 MiB per
request (`413` above that limit); reverse proxies may impose lower limits.
Downloads and host-side COPY are not subject to this request-body limit.
POSIX collection COPY follows a directory link at the source entry and copies
its contents independently; links within that tree retain host copy semantics.
Staged PUT replaces the addressed file entry, including a final-component
symlink, rather than writing through that link. Parent-directory links remain
usable for navigation.

The DAV listener supports depth-0/1 PROPFIND, GET/HEAD (including conditional
reads and single byte ranges), OPTIONS, PUT, MKCOL, MOVE/COPY, DELETE and real
LOCK/UNLOCK with shared/exclusive locks. PROPPATCH returns per-property 403;
arbitrary properties, POSIX permissions/ownership, executable modes, device
files and complete POSIX locking are not provided. Infinite PROPFIND and
multiple byte ranges are rejected. Filenames must be representable in UTF-8
and DAV XML; names containing XML-forbidden controls fail explicitly.

Single-range GET seeks on the selected host rather than transferring its prefix.
Local hosts use native file slices; SSH and Mesh use bounded existing `exec`
windows (POSIX `sh`, `dd` and `base64`, or Windows PowerShell). Hosts lacking
`commandExecution` cannot provide remote ranged reads. Ordinary ranges and
date-based If-Range use metadata only; a strong ETag condition still requires
hashing the whole file. Metadata-only 206 responses omit ETag, since weak
validators are not valid on 206; Last-Modified remains available. A weak or
mismatched If-Range returns the complete 200 representation.

Limits: 64 KiB XML requests, XML depth 32, 32 live listener requests, 64 pending
controller mutations per physical target and 256 across the controller,
10,000 entries per listing/recursive COPY or DELETE,
recursive depth 128, 16 MiB metadata/XML responses, 256 locks per user/target
and 2,048 locks per controller. Locks last at most 3,600 seconds and are
in-memory: controller restarts discard them. They coordinate the new exact-path
surface for the same user/target, not old explorer routes or direct agents.
Shutdown aborts owned requests, closes the listener and attempts to release
locks. Revoked auth, a deleted workspace or an unavailable/changed target can
prevent release; failure is reported and remaining locks expire.
Mutations on different physical targets proceed independently; users sharing a
physical target share its mutation queue. Cancellation is checked immediately
before a non-cancellable host mutation starts; it cannot undo an already-started
delete or rename.

The CLI and controller must be updated. Workers/relays that support the current
`fileOperations` and `commandExecution` contracts need no protocol update.
Native `mount_webdav -S -i` was validated on macOS 27.0.1 arm64 with the CLI
listening on loopback HTTP and an authenticated HTTPS controller/Linux Mesh
worker. Verified native read/write and read-only mounting, binary and Unicode
filenames, exclusive locks rejecting concurrent tokenless writes, mkdir,
rename/delete, editor-style replacement, alternate mounting outside the initial
workspace directory, unmount and CLI shutdown. No extra mounting software or
TLS certificate was needed on the Mac.
Windows WebClient and Linux desktop mounting remain unverified. Windows
WebClient is deprecated and normally requires trusted HTTPS for Basic auth,
while Linux may require additional client components.

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

Terminal `connected`/`connecting` describes a live controller attachment, not the
shell's lifetime. Startup resets those saved states to `disconnected`, including
after an unclean shutdown, without deleting the terminal or stopping its
persistent dtach/tmux shell. Reattach to resume the shell when its execution host
and session survived; direct shells do not have that persistence guarantee.

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
| GET | `/api/agent-runs/:id/snapshot` | Read an agent-run transcript snapshot, paged by non-empty assistant responses (page size 100). |
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
| POST | `/api/chats/:id/new-here` | Create an empty chat in the source chat's current workspace directory and execution target. |
| GET | `/api/chats/:id/activity` | Observe owned native background work. |
| POST | `/api/chats/:id/activity/:activityId/stop` | Stop one owned native child or process. |
| POST | `/api/chats/:id/done` | Mark a standalone chat as done. |
| POST | `/api/chats/:id/interrupt` | Interrupt an active chat run. |
| POST | `/api/chats/:id/messages` | Send a message to a chat session. |
| POST | `/api/chats/:id/messages/:messageId/speech` | Generate a spoken summary for an existing assistant message in an owned chat; no request body. |
| POST | `/api/chats/:id/permissions/:requestId` | Approve or deny a pending chat permission request. |
| POST | `/api/chats/:id/questions/:requestId` | Answer a native question owned by the current chat conversation. |
| DELETE | `/api/chats/:id/queued-messages/:messageId` | Delete a queued chat message. |
| POST | `/api/chats/:id/queued-messages/:messageId/steer` | Steer an existing queued input without interrupting the execution. |
| POST | `/api/chats/:id/queued-messages/:messageId/reconcile` | Recover native delivery without resending the input. |
| POST | `/api/chats/:id/continue-from-history` | Explicitly create a fresh native chat session backed by a temporary persisted-history export. |
| POST | `/api/chats/:id/reconnect` | Reconnect a chat session to its backend runtime. |
| GET | `/api/chats/:id/snapshot` | Read a chat transcript snapshot, paged by non-empty assistant responses (page size 100). |
| POST | `/api/chats/:id/spawn-task` | Create a task from an existing chat transcript. |
| POST | `/api/chats/:id/spawn-task-from-current-plan` | Create a task from the current plan discussed in a chat. |
| GET | `/api/chats/:id/tool-calls/:toolCallId` | Read the full details for one chat tool call. |
| GET | `/api/chats/:id/transcript.html` | Open a chat transcript as a standalone HTML document. |
| GET | `/api/chats/:id/transcript.md` | Download a chat transcript as Markdown. |
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
| POST | `/api/execution-hosts/:kind/:id/files/filesystem` | Exact-path commands, preconditions and DAV locks on the selected host. |
| GET, HEAD, PUT | `/api/execution-hosts/:kind/:id/files/filesystem/content` | Stream, inspect or stage binary content on the selected host. |
| POST | `/api/execution-hosts/:kind/:id/files/delete` | Delete an execution-host file or directory. |
| GET, HEAD | `/api/execution-hosts/:kind/:id/files/download` | Download an execution-host file. |
| GET | `/api/execution-hosts/:kind/:id/files/metadata` | Read execution-host file metadata. |
| GET | `/api/execution-hosts/:kind/:id/files/preview` | Preview a browser-renderable execution-host image file. |
| GET | `/api/execution-hosts/:kind/:id/files/video-preview` | Stream a browser-renderable execution-host video for inline playback. |
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
| GET | `/api/previews` | List active previews and previews with pending cleanup. |
| DELETE | `/api/previews/:previewId` | Close a preview or retry its pending cleanup on the original host. |
| GET | `/api/previews/bridge` | Open the raw websocket bridge for a workspace or direct server preview. |
| POST | `/api/provisioning-jobs` | Start a remote provisioning job. |
| POST | `/api/provisioning-jobs/:id/dismiss` | Dismiss a terminal provisioning job. |
| GET, DELETE | `/api/provisioning-jobs/:id` | Read or cancel a remote provisioning job. |
| GET | `/api/provisioning-jobs/:id/logs` | Read logs for a remote provisioning job. |
| POST | `/api/server-settings/test` | Test a server connection without creating a workspace. |
| POST | `/api/settings/restart-automatic-workspaces` | Start restart jobs for the current user's automatically provisioned workspaces. |
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
| GET | `/api/tasks/:id/activity` | Observe owned native task background work. |
| POST | `/api/tasks/:id/activity/:activityId/stop` | Stop one owned native child or process. |
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
| POST, DELETE | `/api/tasks/:id/pending` | Apply pending values through the interrupt-first path, or clear them. |
| PUT, DELETE | `/api/tasks/:id/pending-prompt` | Set the pending prompt used for the next task iteration. |
| POST | `/api/tasks/:id/pending-inputs/:inputId/steer` | Admit the queued input into the current native execution. |
| POST | `/api/tasks/:id/pending-inputs/:inputId/reconcile` | Recover delivery from the original owned native conversation. |
| GET | `/api/tasks/:id/plan` | Read a task's planning document. |
| POST | `/api/tasks/:id/plan/accept` | Accept a generated task plan. |
| POST | `/api/tasks/:id/plan/discard` | Discard a generated task plan and delete the task. |
| POST | `/api/tasks/:id/plan/feedback` | Submit feedback on a generated task plan. |
| GET | `/api/tasks/:id/pull-request` | Read pull request navigation details for a task. |
| POST | `/api/tasks/:id/pull-request/auto-merge` | Enable pull request auto-merge for a task. |
| POST | `/api/tasks/:id/purge` | Permanently delete a task from storage. |
| POST | `/api/tasks/:id/push` | Push a completed, max-iteration, or locally accepted task branch to the remote repository. |
| GET | `/api/tasks/:id/review-history` | Read review history for a task. |
| GET | `/api/tasks/:id/snapshot` | Read a task transcript snapshot, paged by non-empty assistant responses (page size 100). |
| GET, POST | `/api/tasks/:id/terminal-session` | Read or create a task-backed terminal session. |
| GET | `/api/tasks/:id/status-file` | Read a task's status tracking document. |
| POST | `/api/tasks/:id/stop` | Stop an active task run. |
| GET | `/api/tasks/:id/tool-calls/:toolCallId` | Read one complete task tool-call payload. |
| POST | `/api/tasks/:id/update-branch` | Sync a pushed task branch with its base branch. |
| POST | `/api/tasks/title` | Generate a task title from a prompt. |
| GET, PUT | `/api/voice/settings` | Read or update transcription, shared text-generation, and Live model settings, plus local Piper support status. |
| POST | `/api/voice/validate` | Validate the configured transcription, text-generation, or Live Voice capability. |
| POST | `/api/voice/transcribe` | Transcribe an uploaded audio recording with the configured provider. |
| GET, POST | `/api/voice/live` | Discover or start the user's global voice assistant. |
| GET | `/api/voice/live/:callId` | Read owned ephemeral call state. |
| POST | `/api/voice/live/:callId/heartbeat` | Renew the originating-tab lease and UI context. |
| POST | `/api/voice/live/:callId/close` | End voice without stopping delegated work. |
| POST | `/api/voice/live/:callId/confirmations/:requestId` | Approve or reject a frozen, expiring operation from the originating client. |
| POST | `/api/voice/live/:callId/credentials/:requestId` | Privately supply a request-bound SSH credential token. |
| GET, POST | `/api/worker-update-jobs` | List jobs or start updates for active global Mesh workers. |
| GET | `/api/worker-update-jobs/:id` | Read a worker update job and its logs. |
| POST | `/api/worker-update-jobs/:id/dismiss` | Dismiss a terminal worker update job and its logs. |
| GET, POST | `/api/workspace-worker-enrollments` | List or create workspace-exclusive Mesh worker enrollments. |
| GET, DELETE | `/api/workspace-worker-enrollments/:id` | Read or cancel a workspace-exclusive Mesh worker enrollment. |
| GET, POST | `/api/workspaces` | List workspaces or create a workspace. |
| GET, PUT, DELETE | `/api/workspaces/:id` | Read, update, or delete a workspace. |
| GET | `/api/workspaces/:id/task-creation-context` | Read effective task defaults, connected models and usable branches on the selected host. |
| POST | `/api/workspaces/:id/archived-tasks/purge` | Purge archived tasks for a workspace. |
| POST | `/api/workspaces/:id/agents/import` | Import a portable scheduled-agent configuration into a workspace. |
| POST | `/api/workspaces/:id/exec` | Execute one non-interactive command on the workspace's execution host. |
| GET | `/api/workspaces/:id/files` | List workspace files in the active explorer root. |
| GET | `/api/workspaces/:id/files/content` | Read a workspace file. |
| POST | `/api/workspaces/:id/files/filesystem` | Run an exact-path filesystem command. |
| GET, HEAD, PUT | `/api/workspaces/:id/files/filesystem/content` | Stream, inspect or atomically replace binary content. |
| POST | `/api/workspaces/:id/files/delete` | Delete a workspace file or directory in the active explorer root. |
| GET, HEAD | `/api/workspaces/:id/files/download` | Stream a workspace file from the selected execution host. |
| GET | `/api/workspaces/:id/files/metadata` | Read workspace file metadata. |
| GET | `/api/workspaces/:id/files/preview` | Preview a browser-renderable workspace image file. |
| GET | `/api/workspaces/:id/files/video-preview` | Stream a browser-renderable workspace video for inline playback. |
| POST | `/api/workspaces/:id/files/rename` | Rename a workspace file or directory in the active explorer root. |
| GET | `/api/workspaces/:id/files/tree` | Load the full workspace file tree. |
| POST | `/api/workspaces/:id/files/upload` | Create a workspace file upload session. |
| POST | `/api/workspaces/:id/files/upload/cancel` | Cancel a workspace file upload session. |
| POST | `/api/workspaces/:id/files/upload/chunk` | Upload a raw chunk for a workspace file upload session. |
| POST | `/api/workspaces/:id/files/upload/complete` | Complete a workspace file upload session. |
| POST | `/api/workspaces/:id/files/write` | Write a workspace file with optional conflict checks. |
| POST | `/api/workspaces/:id/pull-latest-changes` | Pull the default branch and refresh remote-tracking branches. |
| GET, PUT | `/api/workspaces/:id/server-settings` | Read or update workspace server settings. |
| GET | `/api/workspaces/:id/server-settings/status` | Read the current workspace connection status. |
| POST | `/api/workspaces/:id/server-settings/test` | Test the configured workspace connection using workspace settings. |
| GET | `/api/workspaces/execution-targets` | List execution hosts and available harness adapters for workspace configuration. |
| GET | `/api/workspaces/:workspaceId/previews` | List previews associated with a workspace. |
| GET | `/api/execution-hosts/:kind/:id/previews` | List direct previews for a local or Mesh execution host. |

</details>

### Workspace execution targets

`GET /api/workspaces/execution-targets` returns the current user's execution-host
descriptors. Harness availability is part of each descriptor:

| Field | Contract |
| --- | --- |
| `harnessAdapters` | Available adapters: `acp`, `copilot`, `codex`, `opencode2`, constrained by the execution host and Mesh route. |
| `harnessAdapterError` | Optional `mesh_execution_protocol_mismatch` when route negotiation cannot be verified; `harnessAdapters` is empty. |

The optional `workspaceId` or connected `workspaceWorkerEnrollmentId` query
includes that user's dedicated worker. Its reference retains the workspace or
enrollment scope; dedicated workers are not listed in global host discovery.

### Tasks CRUD

Before constructing a task, read
`GET /api/workspaces/:id/task-creation-context`. It returns workspace
capabilities, effective `defaults`, model preferences and available models,
real host Git branches, unmet `requirements`, and `ready`. Nullable model or
branch selections are not invented defaults. Apply explicit choices and valid
browser-saved preferences using `preferencePrecedence`; then submit through the
ordinary task API. This read uses the workspace's selected execution host and
does not expose credentials or change ordinary creation authorization.

The global [voice assistant](voice.md#live-voice) discovers per-method schemas
and automation policies from actual route definitions. Reads/writes use the
normal authenticated framework dispatch; high-risk operations require a visual
confirmation with a short model-written action description. The voice-only tool
field `confirmationDescription` is required (1–500 trimmed characters for
`confirm`, `null` otherwise); it is not part of the target API body. The browser
receives the frozen description, request identifier and expiry, not private
operation arguments. Approval executes only the bound, revalidated operation,
and background admission is distinct from completed work.
Credential-management, raw transport and binary protocols remain outside its
JSON operation surface.

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
| `maxIterations` | number \| null | Yes | Maximum iterations; use `null` for unlimited |
| `maxConsecutiveErrors` | number | Yes | Maximum consecutive errors before the failsafe stops the task |
| `activityTimeoutSeconds` | number \| null | No | Seconds without events before ending the current turn normally. Defaults to 330 seconds when omitted or `null`; finite values must be at least 60 seconds. |
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
  "maxIterations": 10,
  "maxConsecutiveErrors": 10,
  "activityTimeoutSeconds": 330,
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

- If `draft: true`, the task is saved with status `draft` and no git branch is created.
- Otherwise, Clanky generates a plan and the task enters `planning`. The plan is
  accepted automatically when `autoAcceptPlan` is `true`; otherwise it waits
  for user acceptance.
- If `uploadedPlan` is provided, Clanky uses it instead of generating a plan
  and starts execution from it.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `validation_error` | Missing or invalid fields |
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `model_not_enabled` | The selected model is not available or not connected |
| 400 | `provider_not_found` | The specified provider was not found |
| 400 | `model_not_found` | The specified model was not found on the provider |
| 404 | `workspace_not_found` | Workspace not found for the given workspaceId |
| 500 | `start_plan_failed` | Task created but failed to start planning |
| 500 | `start_uploaded_plan_failed` | Task created but failed to start from the uploaded plan |
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
| `activityTimeoutSeconds` | number \| null | Update activity timeout; inactivity ends the current turn normally (`null` resets it to the 330-second default; omitting this field leaves it unchanged) |
| `stopPattern` | string | Update stop pattern |
| `baseBranch` | string | Update base branch |
| `useWorktree` | boolean | Update worktree usage before the task has started |
| `clearPlanningFolder` | boolean | Update clear planning folder flag |
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

Logically delete a task. The deleted status is persisted before provider,
terminal-session, linked-chat, managed-credential, or Git cleanup is attempted.
Cleanup runs best-effort; a failure can leave an external resource behind but
does not block or undo task deletion.

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

Tasks start by generating a plan when created (unless `draft: true`). Plans can
be accepted manually or automatically with `autoAcceptPlan`. The following
endpoints control task lifecycle after creation.

#### POST /api/tasks/:id/draft/start

Start a draft task. Transitions the task from `draft` status to `planning`.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `attachments` | array | Yes | Message attachments; use an empty array when there are none |

**Response**

Returns the updated task object.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Task not found |
| 400 | `not_draft` | Task is not in draft status |
| 400 | `invalid_json` | Request body is not valid JSON |
| 500 | `start_plan_failed` | Failed to start planning |

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

Mark a task deleted and attempt best-effort provider, session, credential, and
Git cleanup. A failure does not block deletion. Dedicated worktrees can remain
until the task is purged.

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
The task record is removed before provider, terminal-session, credential, and
Git cleanup runs. Cleanup failures do not block purging. A worktree is removed
only when the execution engine and workspace safety checks confirm that no
writer remains; otherwise it is left in place.

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

**Request Body** (optional)

```json
{
  "directory": "/path/to/working/directory"
}
```

`directory` sets the working directory only when a new task-linked terminal
session is created. If a session already exists, it is returned unchanged.
When omitted, a new session uses the task's worktree directory, if configured,
or its task directory otherwise.

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

Set the pending prompt for the next iteration without interrupting the current
execution. Read its stable ID from `state.pendingInput.id` in the task snapshot
before using native Steer or reconciliation.

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

The collection response omits `scratchpad` to avoid returning every note body. Read an individual workspace to retrieve its saved note.

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
        "adapter": "acp",
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
| `serverSettings` | object | Yes | Adapter and harness preset, for example `{ "agent": { "adapter": "acp", "provider": "copilot" } }` |
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

Returns the workspace object, including its saved `scratchpad` content. Unsaved browser-local drafts are not included.

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
| `serverSettings` | object | Update the harness adapter and preset |
| `executionHost` | object | Replace the registered execution host |
| `sshTarget` | object \| null | Replace or clear the ad hoc SSH target |
| `isPrivate` | boolean | Hide the workspace when private items are hidden |
| `archived` | boolean | Hide the workspace from active work surfaces |
| `allowClankyContext` | boolean | Allow authenticated Clanky CLI access in new execution contexts |
| `allowWorktrees` | boolean | Enable or disable creation of task, chat, and agent worktrees |
| `scratchpad` | string | Replace the saved Markdown note (maximum 100,000 characters); send the complete content, or an empty string to clear it |

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

#### GET /api/workspaces/:id/files/video-preview

Stream a browser-renderable video inline from the host selected by the workspace.
The route accepts a URL-encoded `path` query parameter and supports MP4
(`.mp4` and `.m4v`) and WebM (`.webm`) MIME types. Codec support depends on the
browser; Clanky does not transcode media. Other file types remain available
through the download route.

Relative paths resolve from `workspace.directory`; absolute paths are used
directly on the selected host. The response is streamed rather than buffered as
a complete browser `Blob`, with `Content-Disposition: inline`,
`Cache-Control: no-store`, `Content-Type`, and `X-Content-Type-Options: nosniff`.
The request is cancellable when the media element stops reading.

A satisfiable single `Range: bytes=...` request returns `206 Partial Content`
with `Content-Range`, `Content-Length`, and `Accept-Ranges: bytes`. Malformed,
multiple, or unsatisfiable ranges return `416` with `Content-Range: bytes */size`.
If the selected execution host cannot perform a ranged read, Clanky streams the
complete video with `200 OK` and `Accept-Ranges: none`; playback can proceed
sequentially, but seeking is not available for that response.

The equivalent route is available under
`/api/execution-hosts/:kind/:id/files/video-preview`.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_workspace_path` | The requested path is invalid. |
| 400 | `invalid_path_type` | The requested path is a directory rather than a regular file. |
| 400 | `invalid_preview_type` | The requested file is not a supported video type. |
| 404 | `workspace_not_found` | Workspace not found or not owned by the caller. |
| 404 | `file_not_found` | The requested file does not exist on the selected host. |
| 416 | `file_range_unsatisfiable` | A single satisfiable byte range is required. |
| 500 | `workspace_file_error` | Video streaming failed. |

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
renaming, and deleting) likewise use their active root as a navigation starting
point, not a containment boundary. Their operation-specific path validation,
conflict checks and destructive-operation safeguards still apply.

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

### Server Settings

Server settings select the harness adapter and preset for a workspace. The execution host
is configured separately on the workspace through `executionHost`, `sshTarget`,
or `workspaceWorkerEnrollmentId`.

```json
{
  "agent": {
    "adapter": "acp",
    "provider": "opencode"
  }
}
```

Supported adapters are `acp`, `copilot`, `codex` and `opencode2`.
ACP presets are `opencode`, `copilot`, `codex`, `claude`, `pi` and `grok`.
Native adapters require their matching preset: `copilot`, `codex`, and
`opencode` respectively. Existing persisted settings migrate to ACP; public
settings requests must include the canonical adapter field.

#### GET /api/workspaces/:id/server-settings

Get server settings for a specific workspace.

**Response**

```json
{
  "agent": {
    "adapter": "acp",
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
| `agent.adapter` | string | Yes | `acp`, `copilot`, `codex` or `opencode2`, supported by the selected host/path |
| `agent.provider` | string | Yes | `opencode`, `copilot`, `codex`, `claude`, `pi`, or `grok` |

**Response**

```json
{
  "agent": {
    "adapter": "copilot",
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
  "adapter": "acp",
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

Test the current workspace connection, or test a proposed adapter/preset.

**Request Body**

Pass `{}` or no body to use the workspace's current settings. To test a
different adapter, send a server-settings object:

```json
{
  "agent": {
    "adapter": "codex",
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
| `settings.agent.adapter` | string | Yes | `acp`, `copilot`, `codex` or `opencode2`, supported by the selected host/path |
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

#### POST /api/settings/restart-automatic-workspaces

Start one asynchronous provisioning restart job for each of the current user's
workspaces with a non-empty `sourceDirectory`, matching the existing
per-workspace Restart action. Each job uses the workspace's saved provisioning
host, transport, target directory, and runtime settings. This endpoint starts
jobs; it does not wait for them to finish. Read each returned job ID with
`GET /api/provisioning-jobs/:id` to observe its final state.

The route requires owner authorization and a same-origin mutation. A start
failure for one workspace is returned in `failures` and does not prevent
attempts for other eligible workspaces.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `credentialTokensByServerId` | object | No | Short-lived SSH credential tokens keyed by registered SSH server ID. Omit when no saved browser credential is available. |
| `credentialUnavailableServerIds` | string[] | No | Registered SSH server IDs for which the browser could not exchange a saved credential. Eligible workspaces using those servers are reported as start failures. |

Both fields default to empty values.

**Response**

```json
{
  "success": true,
  "totalWorkspaces": 2,
  "started": [
    {
      "workspaceId": "workspace-1",
      "workspaceName": "First workspace",
      "provisioningJobId": "job-1"
    }
  ],
  "failures": [
    {
      "workspaceId": "workspace-2",
      "workspaceName": "Second workspace",
      "error": "Unable to retrieve the saved SSH credential for this server."
    }
  ]
}
```

`totalWorkspaces` is the number of eligible workspaces. Entries in `started`
represent jobs accepted for processing, not successful restarts. Later runtime
failures are recorded in the provisioning job state.

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

Registration waits for its RSA-4096 credential-encryption key to be persisted
before returning. Key generation runs asynchronously without blocking the
server's event loop; unrelated requests and realtime delivery remain available.
The encryption algorithm and public-key contract remain `RSA-OAEP-256`.

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
| `adapter` | string | No | `acp` (default), `copilot`, `codex`, or `opencode2`; native adapters require worker transport |
| `provider` | string | Yes | ACP harness preset, or the native adapter's matching provider (`opencode` for `opencode2`) |
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
  "adapter": "copilot",
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

New worker workspaces persist the requested adapter. Direct SSH execution
requires `adapter: "acp"`; the Devbox provisioning host may itself use SSH while
creating a native worker. Rebuild/restart uses the workspace's current saved
adapter/preset, not a stale selection in the submitted request. Existing jobs
without an adapter retain ACP semantics. See
[automatic runtime installation](mesh-worker.md#automatic-workspace-runtimes)
for durable CLI installation and external Devbox rebuilds.

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

Provisioning, automatic-workspace restart/rebuild, and server-update jobs share
these execution semantics:

- Active statuses are `pending`, `running`, and `verifying`. Terminal statuses
  are `completed`, `not_started`, `connection_failed`, `failed`, `cancelled`,
  `interrupted`, and `unconfirmed`.
- `connection_failed` means the selected host could not be reached before the
  next command was dispatched. `failed` preserves a returned command failure.
  `interrupted` requires observed execution and confirmed termination;
  `unconfirmed` means execution may have happened without a confirmed outcome.
- New snapshots include `hasDispatchedCommands` and, once a command is
  attempted, its `execution`: `step`, `state` (`not_started`, `dispatched`, `started`, or
  `finished`), optional `outcome`, and a returned `exitCode` when available.
  Dispatch is not proof of process start. `startedAt` records observed
  execution, not job admission or connection attempts. Earlier commands may
  have completed before the current command fails to connect.
- An uncertain automatic-workspace restart/rebuild enters `verifying`.
  Clanky checks read-only Devbox status, then the normal worker/backend
  connection. `recovery.status` becomes `confirmed` only after those checks
  pass; an unverified outcome remains `unconfirmed`. The disruptive command is
  never automatically replayed. Server `arise` has no equivalent completion
  proof, so a lost result remains unconfirmed.
- Controller startup does not resume or replay active commands. Affirmative
  no-dispatch evidence becomes `not_started`; other unfinished operations
  become `unconfirmed`. Legacy startup-interrupted records are reconciled
  conservatively without fabricating execution evidence.

**Errors**

| Status | Error | Description |
|--------|-------|-------------|
| 404 | `not_found` | Provisioning job not found |
| 500 | `provisioning_error` | Failed to read provisioning job state |

#### DELETE /api/provisioning-jobs/:id

Cancel a provisioning job.

User cancellation retains status `cancelled` and error code `cancelled`.
Inspect `execution.outcome` separately: terminating the controller's SSH
client cannot prove that its remote command stopped. An unconfirmed
cancellation is not offered the Retry shortcut; inspect the host before starting
another operation.

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

### Mesh worker updates

Worker update routes require owner authorization and same-origin protection for
mutations. `POST /api/worker-update-jobs` accepts no request body and starts a
separate background job for every active global Mesh worker registration.
Registrations with `registrationScope: "workspace"` are excluded, so
workspace-exclusive automatic workers are not updated by this operation.
Different workers run concurrently; each job runs its own commands in order:

1. `clanky update`
2. `clanky worker service restart`, only after the update exits successfully.

On macOS, the restart command uses `launchctl kickstart` so a Mesh-issued
command can restart the LaunchAgent that owns the worker without unloading it
before the replacement process starts.

An update failure skips the restart and fails only that worker's job. A
successful admission means the job was created, not that either command
completed. Each worker's execution result and logs remain available on the
Dashboard until its terminal job is dismissed. The restart response wait and
recovery confirmation share a 20-second deadline. Restart uses a host-owned
asynchronous command dispatched only once. Bounded response observation cannot
cancel that process; an acknowledged, still-running command is observed until
it finishes, its connection is lost, or the deadline expires. The job then
polls every second for signed Mesh health and an installed, running worker
service through a fresh execution connection. A lost response
after dispatch does not by itself interrupt the job or cause the restart
command to be resent. Failures before dispatch cannot be confirmed as successful
restarts, including relay setup failures before the command body is sent.
Transient discovery HTTP 502/503/504 and interrupted response bodies are retried;
malformed probe responses, protocol and authorization failures stop verification.
Explicit command failures fail the job; recovery
that cannot be confirmed records an `unconfirmed`
outcome rather than success or interruption. If the restart exit code was lost, a confirmed
recovery succeeds without an invented exit code.

Connection establishment errors before command dispatch use `connection_failed`.
A received nonzero command exit uses `failed`. `interrupted` requires evidence
that execution started and termination was confirmed; lost observation alone
uses `unconfirmed`, since the remote process may still be running.

#### POST /api/worker-update-jobs

Start update jobs for all active global Mesh worker registrations. The response
is `202 Accepted`; `totalWorkers` is the number of eligible registrations, and
`results` contains one admission result per worker.

```json
{
  "success": true,
  "totalWorkers": 2,
  "results": [
    {
      "workerNodeId": "worker-1",
      "workerName": "build-east",
      "status": "started",
      "jobId": "job-1"
    },
    {
      "workerNodeId": "worker-2",
      "workerName": "build-west",
      "status": "failed",
      "error": "Unable to create worker update job."
    }
  ]
}
```

`status: "failed"` in this response means that the job could not be admitted;
it is distinct from a job that was admitted and later failed while running.
One worker's admission failure does not prevent jobs from being created for
other eligible workers. If that owner already has a `pending` or `running`
update job for a worker, the result for that worker is `not_started` with
`reason: "already_active"`; no duplicate command sequence is admitted.

#### GET /api/worker-update-jobs

List retained worker update jobs for the owner. The collection omits logs;
read an individual job to inspect its output.

```json
{
  "jobs": [
    {
      "config": {
        "id": "job-1",
        "workerNodeId": "worker-1",
        "workerName": "build-east",
        "createdAt": "2026-06-01T12:00:00.000Z"
      },
      "state": {
        "status": "running",
        "currentStep": "update",
        "steps": {
          "update": { "status": "running" },
          "restart": { "status": "pending" }
        },
        "updatedAt": "2026-06-01T12:00:01.000Z"
      }
    }
  ]
}
```

Job statuses are `pending`, `connecting`, `running`, `verifying`, `completed`,
`not_started`, `connection_failed`, `failed`, `interrupted`, and `unconfirmed`.
Each `update` and `restart` step has its own status
(`pending`, `connecting`, `running`, `verifying`, `succeeded`, `not_started`,
`connection_failed`, `failed`, `interrupted`, `skipped`, or `unconfirmed`),
timestamps, optional exit code, and optional error. Optional step `execution`
records evidence: `not_started`, `dispatched`, `started`, or `finished`.
Dispatch and an accepted asynchronous request do not prove process start;
observed command output does. `startedAt` is recorded only when that evidence
is observed, not during connection establishment.

After controller restart, jobs without command dispatch remain `not_started`;
possible execution without a retained result becomes `unconfirmed`. If earlier
steps completed but the pipeline stopped before dispatching the next step,
the job uses `failed` with `worker_update_pipeline_stopped`, preserving completed
step results and the next step's undispatched state. Legacy
interrupted jobs that recorded only a lost observation are reclassified without
inventing execution evidence. Recovery never replays either command.

#### GET /api/worker-update-jobs/:id

Read a job and its retained logs.

```json
{
  "job": {
    "config": {
      "id": "job-1",
      "workerNodeId": "worker-1",
      "workerName": "build-east",
      "createdAt": "2026-06-01T12:00:00.000Z"
    },
    "state": {
      "status": "completed",
      "currentStep": null,
      "steps": {
        "update": { "status": "succeeded", "exitCode": 0 },
        "restart": { "status": "succeeded", "exitCode": 0 }
      },
      "startedAt": "2026-06-01T12:00:01.000Z",
      "completedAt": "2026-06-01T12:00:08.000Z",
      "updatedAt": "2026-06-01T12:00:08.000Z"
    }
  },
  "logs": [
    {
      "id": "log-1",
      "source": "system",
      "text": "Starting clanky update.",
      "timestamp": "2026-06-01T12:00:01.000Z",
      "step": "update"
    }
  ]
}
```

Returns `404 not_found` when the job is not available to the owner.

#### POST /api/worker-update-jobs/:id/dismiss

Permanently remove a terminal job and its logs.

```json
{
  "success": true,
  "dismissed": true
}
```

Returns `404 not_found` when the job does not exist and `409
worker_update_job_active` while it is pending, connecting, running, or verifying.
All terminal outcomes are retained and can be dismissed.

---

### Git

#### GET /api/git/branches

List local branches and cached remote-tracking branches for a workspace. This
endpoint does not contact remotes; its remote entries reflect the last fetch.
Remote branch names include the remote name, such as `origin/feature/auth`.
`currentBranch` identifies the checked-out local branch.

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
    { "name": "add-tests-1a2b3c4", "current": false },
    { "name": "origin/feature/auth", "current": false }
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

**Dynamic Interests**

Use one connection without URL filters. An open connection receives no
application events until it has an acknowledged interest. Subscribe and
unsubscribe on that connection as the visible resources change:

```json
{"type":"subscribe","subscriptionId":"task-content","generation":1,"interest":{"kinds":["content"],"targets":{"taskId":"abc-123"}}}
{"type":"subscribe","subscriptionId":"task-state","generation":1,"interest":{"kinds":["state"],"resources":["tasks"],"ids":["abc-123"]}}
{"type":"unsubscribe","subscriptionId":"task-content","generation":1}
```

Wait for the matching `subscribed` acknowledgement before loading an
authoritative baseline. A subscription identity and generation distinguish
current interests from obsolete acknowledgements and delivery.

| Interest field | Description |
| --- | --- |
| `kinds` | Required categories: `state` invalidations, `content` deltas, or transient `action` commands |
| `resources` | Resource names such as `tasks`, `chats`, or `agent-runs` |
| `ids` | Entity IDs for resource invalidations |
| `scopes` | Resource scopes, such as an agent ID for `agent-runs`, workspace ID for workspace `previews`, or serialized execution-host reference for direct server `previews` |
| `types` | Concrete event names |
| `targets` | Named publication targets, such as `taskId`, `chatId`, `agentId`, `agentRunId`, or `provisioningJobId`, with one or more accepted values |

At least one concrete selector besides `kinds` is required. Interests only
narrow delivery; they cannot override authenticated user ownership. Use
separate interests for metadata and content rather than subscribing the
sidebar to transcript bodies. Compact `chat-activity` state events update
sidebar activity without distributing message, log or tool content.

Chat entities and snapshots expose `state.revision`, a persisted, monotonically
increasing integer scoped to that chat ID. Chat metadata, configuration,
persisted stream checkpoints and harness projections advance it atomically.
Metadata changes invalidate `chats`; the resulting authoritative snapshot
supplies that revision and entity state. Activity and provider timestamps are
presentation data, not state versions, and transcript deltas do not imply a
lifecycle transition. Content uses the separate positions described under
[transcript snapshots](#transcript-snapshots).

Realtime has no replay history. After reconnecting, restore interests, await
activation and read fresh authoritative baselines. Buffer concurrent content
updates and apply only contiguous successors of the snapshot position.
Recover from gaps, changed epochs or bounded-buffer overflow with a new
baseline; persistent failures remain visible. Do not replay non-idempotent
transient commands. Application views use the framework's shared transport,
live-query mutation barriers and versioned synchronization rather than
implementing their own reconnect/read coordinators.

**Connection URL Examples**

```
ws://localhost:3000/api/ws   # Send subscription frames after connecting
wss://example.com/api/ws    # Secure WebSocket
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
  "subscriptions": [
    { "subscriptionId": "task-state", "generation": 1 }
  ],
  "event": {
    "type": "tasks.changed",
    "resource": "tasks",
    "action": "changed",
    "id": "abc-123"
  }
}
```

A publication matching overlapping interests is delivered once, with all
matching subscription identities and generations listed in the envelope.

Resource invalidations use these resource names and actions:

| Event type | Description |
|------------|-------------|
| `tasks.changed`, `tasks.deleted` | Task collection or entity changed/deleted |
| `chats.changed`, `chats.deleted` | Chat collection or entity changed/deleted |
| `chat-activity.changed` | Compact chat activity timestamp/source update |
| `agents.changed`, `agents.deleted` | Agent collection or entity changed/deleted |
| `agent-runs.changed`, `agent-runs.deleted` | Agent-run collection or entity changed/deleted |
| `terminal-sessions.changed`, `terminal-sessions.deleted` | Workspace terminal collection or entity changed/deleted |
| `provisioning-jobs.changed`, `provisioning-jobs.deleted` | Provisioning-job collection or entity changed/deleted |
| `worker-update-jobs.changed`, `worker-update-jobs.deleted` | Worker update-job collection or entity changed/deleted |
| `previews.changed`, `previews.deleted` | Preview collection or entity changed/deleted |
| `mesh.changed`, `mesh.deleted` | Mesh controller or worker state changed/deleted |
| `execution-hosts.changed`, `execution-hosts.deleted` | Execution-host collection or entity changed/deleted |

Selected incremental events are sent as the nested `event` value. The retained
event types are:

| Area | Event types |
|------|-------------|
| Tasks | `task.message`, `task.message.delta`, `task.tool_call`, `task.tool_call.extra`, `task.log`, `task.log.delta`, `task.iteration.start`, `task.iteration.end`, `task.git.commit` |
| Chats | `chat.message`, `chat.message.delta`, `chat.tool_call`, `chat.tool_call.extra`, `chat.log`, `chat.log.delta` |
| Agent runs | `agent.run.message`, `agent.run.message.delta`, `agent.run.tool_call`, `agent.run.tool_call.extra`, `agent.run.log`, `agent.run.log.delta` |
| Provisioning | `provisioning.step`, `provisioning.updated`, `provisioning.output` |

Provisioning execution/state transitions publish a positioned
`provisioning.updated` job cut and owner-targeted resource invalidation.
Output entries advance the same stream; active command state does not depend
on polling or the next step transition.

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
{"type":"event","subscriptions":[{"subscriptionId":"task-content","generation":1}],"event":{"type":"task.iteration.start","taskId":"abc-123","iteration":3,"timestamp":"2026-01-20T10:15:00.000Z"}}

{"type":"event","subscriptions":[{"subscriptionId":"task-content","generation":1}],"event":{"type":"task.log","taskId":"abc-123","id":"log-1","level":"info","message":"Sending prompt to AI","timestamp":"2026-01-20T10:15:01.000Z","streamPosition":{"epoch":"run-incarnation","baseRevision":0,"revision":1}}}
```

**JavaScript Example**

```javascript
const ws = new WebSocket('ws://localhost:3000/api/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    subscriptionId: 'task-content',
    generation: 1,
    interest: {
      kinds: ['content'],
      targets: { taskId: 'abc-123' },
    },
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'subscribed') {
    console.log('Interest activated; an authoritative baseline can now be read');
    return;
  }
  if (data.type !== 'event' || !data.event) {
    return;
  }
  console.log('Event:', data.event.type, data.event);
};

ws.onclose = () => {
  console.log('Disconnected');
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
| `planning` | Generating a plan or awaiting plan approval |
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

Tasks start by generating a plan upon creation (unless `draft: true`).

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
    "maxIterations": 10,
    "maxConsecutiveErrors": 10,
    "activityTimeoutSeconds": 330,
    "stopPattern": "<promise>COMPLETE</promise>$",
    "git": { "branchPrefix": "", "commitScope": "" },
    "baseBranch": "main",
    "clearPlanningFolder": false,
    "autoAcceptPlan": false,
    "fullyAutonomous": false,
    "draft": false
  }'

# Response: {"config":{"id":"abc-123",...},"state":{"status":"planning",...}}

# Connect using the configured profile
clanky ws
```

Then send this JSON line on stdin:

```json
{"type":"subscribe","subscriptionId":"task-content","generation":1,"interest":{"kinds":["content"],"targets":{"taskId":"abc-123"}}}
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
    "maxIterations": 10,
    "maxConsecutiveErrors": 10,
    "activityTimeoutSeconds": 330,
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
  -d '{"attachments": []}'
```

### Create a Task and Auto-Accept Its Plan

Set `autoAcceptPlan` to `true` to start executing the generated plan without
waiting for manual approval.

```bash
# Create a task with an auto-accepted plan
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
    "maxIterations": 10,
    "maxConsecutiveErrors": 10,
    "activityTimeoutSeconds": 330,
    "stopPattern": "<promise>COMPLETE</promise>$",
    "git": { "branchPrefix": "", "commitScope": "" },
    "baseBranch": "main",
    "clearPlanningFolder": false,
    "autoAcceptPlan": true,
    "fullyAutonomous": false,
    "draft": false
  }'

# Response: {"config":{"id":"abc-123",...},"state":{"status":"planning",...}}

# Once the plan is ready, Clanky accepts it and starts execution automatically.
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
