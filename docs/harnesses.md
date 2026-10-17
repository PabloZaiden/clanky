# Harness adapters, activity and steering

## Workspace configuration

Choose the adapter in the existing workspace settings page. Tasks and chats
continue to choose a model and variant from that workspace's harness catalog.
Clanky scheduled Agents inherit the same execution behavior; they are not
harness subagents.

| Adapter | `agent.adapter` | `agent.provider` | Runtime |
| --- | --- | --- | --- |
| GitHub Copilot | `copilot` | `copilot` | Installed and authenticated current Copilot CLI |
| Codex | `codex` | `codex` | Installed and authenticated current Codex CLI, using app-server |
| OpenCode 2 | `opencode2` | `opencode` | Installed current `opencode2` runtime for generation 2 |
| ACP | `acp` | Selected harness preset | Existing ACP-capable Copilot, Codex, OpenCode, Claude, Pi or Grok integration |

Native adapters are experimental. Install and authenticate the harness on the
selected execution host, not necessarily on the controller. The Clanky server
or worker must be able to find its CLI in the configured `PATH`. Native startup
does not install or upgrade the harness automatically. Automatic Devbox
workspaces are the exception: their persistent hook manages the selected native
CLI in a private workspace prefix. See
[automatic workspace runtimes](mesh-worker.md#automatic-workspace-runtimes).

Local hosts and end-to-end Mesh v6 paths support native adapters. Every
controller, relay, and worker on a Mesh route must use v6; direct SSH supports
ACP only. A native failure does not switch to ACP; select ACP explicitly when
that is the desired integration. See [Mesh workers](mesh-worker.md) for setup
details.

Existing workspace settings migrate to ACP with their original harness preset.
Selecting a different adapter does not reinterpret a saved session ID. Start a
new conversation when changing adapters; app transcript history is preserved.
Clanky resumes its own sessions, but no longer imports external harness sessions
or offers conversation forks.

Tasks and chats have the same Mesh worker isolation: maintenance on another
worker does not close their sessions. If their own worker is revoked or its
route becomes invalid, the interruption remains visible and native prompts
are not automatically resent. See
[independent worker lifecycle](mesh-worker.md#independent-worker-lifecycle).

OpenCode 2 uses a separate profile under the Clanky data directory. It does not
upgrade an existing OpenCode generation-1 data directory in place. Configure
the required providers for that profile or through the execution-host environment.

Native OpenCode 2 chats in the configured Quick Chat workspace support
[Clanky Control](control-chats.md), with the same shared tools as Codex and
Copilot. Clanky loads a managed native plugin and private loopback bridge on
the execution host; no separate plugin installation, ACP adapter or MCP
configuration is needed. The installed runtime must support the generation-2
Promise plugin API. Plugin activation and managed credentials are checked
before admitting a Control conversation.

[Live voice](voice.md#live-voice) is a global sidebar assistant, independent of
OpenCode, Quick Chat and any selected chat or native adapter.

## Connection context and helper isolation

Model catalogs, variants, task titles, PR metadata and review-feedback helpers
reuse a workspace connection only when its user, workspace, execution-host
binding and revision, adapter/provider, runtime settings and directory match.
An incompatible operation opens its own connection instead of reconnecting the
shared one. Concurrent first requests for the same context share initialization.

Each helper conversation has its own identity and unattended question policy.
An isolated connection stays open through its helper's session cleanup and is
then disconnected on success or failure. Workspace reset, shutdown and scoped
Mesh invalidation also include these temporary connections. Execution-host model
discovery uses independent temporary connections for concurrent requests; its
catalog cache is separate from their operation identities. Catalog caches are
scoped by user, workspace or host binding/revision, adapter/provider and directory.

Task and chat connections remain dedicated to their entity and user. Helpers
never borrow those conversations or move their worktree context. This isolation
does not authorize resuming a saved conversation under a different binding; the
existing session-ownership checks still apply.

## Continue from history

When a chat is failed because its provider-native session cannot be resumed,
use **Continue from history** to explicitly create a new native session for the
same Clanky chat. Ordinary reconnect still resumes the original session; Clanky
does not replace, interrupt, or delete it automatically, and it may still exist.
The chat transcript and chat ID remain unchanged. History continuation is
blocked while the chat has an active run, queued input, unresolved delivery,
question, or permission request.

Before the new session handles its first message, Clanky writes the persisted,
user-visible transcript as JSON Lines to
`<chat-directory>/.clanky-chat-history/<chat-id>/<recovery-id>/conversation.jsonl`
on the selected execution host. Attachment bytes are stored in the sibling
`attachments/` directory and referenced by relative path. The managed export is
excluded from Git. The new agent receives the export path and is asked to read
it incrementally as untrusted context; old requests, uncertain or queued input,
and tool actions are not replayed.

The export is removed after the first continuation completes successfully or
when the chat is deleted. It cannot be used after its 24-hour expiry. Expiry is
not a background deletion job: physical cleanup is attempted when the export
is next used/replaced or during chat deletion. For a registered SSH host, this
needs a fresh credential; Clanky does not persist SSH credentials, so an
unreachable or unauthenticated host may retain the expired file until the next
authorized recovery attempt or chat deletion.

## Activity and individual Stop

Open **Activity** from the existing task or chat action menu. Inside a task's
Chat tab, **Chat activity** targets the attached chat; the task's **Activity**
action targets task execution. Returning preserves the composer draft and
transcript position. Related tool rows never show inline activity status
labels. They show only an **Activity** link while any associated activity is
running; otherwise, no inline activity summary is shown. No permanent panel is
added.

Activity updates automatically, including after the principal turn finishes.
Subagent rows show their title, reported model and status. **Stop** targets that owned activity, not the principal,
siblings, worker or independently managed Clanky terminals/previews. A
`stopping` or `unknown` result is not confirmed termination.

An unavailable or partial observation does not prove that no work is running.
ACP does not advertise native activity or steering. A principal response can
finish while native background work remains observable.

Chat streaming follows the principal execution, not the lifetime of background
processes. When the principal finishes, the chat becomes idle and accepts a new
message normally, even if a background server is still running. Those processes
remain visible and controllable in **Activity**; finishing a turn does not stop
them. Copilot uses its principal `assistant.idle` signal rather than waiting for
session-wide idle, which only refreshes activity and never completes a prompt.
Codex and OpenCode use their principal execution completion signals. **Steer**
only applies while the principal is actually executing.

For tasks, the completion marker seals the logical result. Owned native cleanup
and safe Git finalization happen separately. Active or unconfirmed writers can
block acceptance/push without restarting task iterations or discarding completion.
OpenCode also retains observed foreign or unattributed shells in the selected
directory as unverified external activity. They can block Git finalization,
but Clanky does not stop them individually or during owned cleanup.

## Queued input and Steer

Queue a message as before. When the active native adapter supports it, use the
small **Steer** text action beneath that queued input to inject it into the
current execution. This does not cancel/restart the turn or switch its model.
Ordinary queueing and interrupt-and-send remain separate actions.

A message can include up to 20 attachments. Each attachment is limited to
20 MiB per file and 60 MiB total per provider turn. The total includes messages
grouped from the queue and images steered into an active turn.

`accepted` means native admission, not delivery or model obedience.
`delivered` means native history confirms the message. An `unknown` admission
retains the input and blocks deletion, replacement or blind resend. Clanky
reconciles unresolved admission automatically against the original owned native
conversation while the chat or task is open; status updates appear without a
manual check. Reconciliation is serialized per entity, starts at least 250 ms
apart, and batches up to five results before refreshing the entity. Reconciliation
updates and realtime invalidations share a 500 ms refresh-coalescing window, so
each receipt does not trigger a separate snapshot request. Transient network,
timeout, rate-limit and server failures retry with backoff. Permanent request
failures stop automatic retries and expose a **Retry check** recovery action
that only reconciles the existing receipt; it never resends the input. Leaving
and reopening the entity resumes reconciliation. Codex can recover by the
canonical input/client ID even if the admission reply, native message ID or turn
ID was lost.
Deterministic pre-admission validation errors retain their typed error and mark
the input as rejected, so it can be corrected or removed. For example, Codex
does not accept inline non-image binary attachments such as PDFs; those failures
are not uncertain deliveries.

## Provider-generated images

Codex image-generation results and inline image blocks returned by providers are
shown as separate assistant messages with image attachments. The image bytes
are removed from tool output, so an image is not represented by a tool-call row.
Clanky validates the actual image bytes against the existing PNG, JPEG, WebP and
GIF allowlist and the 20 MiB per-image and 60 MiB per-turn attachment limits.
Unsupported, malformed or oversized images are omitted with a warning while the
provider's text response continues. Mesh normally forwards the validated inline
image. If a Codex image exceeds Mesh's 2 MiB event limit, Clanky reloads the
matching `savedPath` through the selected execution host and validates the file
before attaching it to chat. If that path is unavailable or does not match the
validated image metadata, the image is omitted with a warning; other events and
the text response continue normally. Mesh providers without a supported file
reference retain the omission warning when an image exceeds the event limit.

Open an image attachment to preview it, then tap or click the image in the dialog
to open the full image alone in a new browser tab. Clanky preserves the image
bytes received from the provider and does not force a download; use the
browser's save or share options.

## Questions

Interactive chats show native questions inline. Choose an offered option or
enter another answer when the harness permits it, then use **Send answer**.
Multiple-selection requests accept more than one choice. A blocking question
shows the chat as waiting; normal composer messages remain queued rather than
being interpreted as the answer. **Stop** interrupts the pending execution.
Task-attached chats use the same interactive behavior.

New questions appear in the transcript as assistant messages, and submitted
answers as user messages, without opening a tool call. Requests with several
fields remain grouped, with numbered questions and matching answers; an empty
optional field is not treated as an answer. These messages survive reloads,
reconnects and loading older history, and are included in Markdown/HTML exports.
Existing tool details remain available. Earlier question history is not
converted.

Question text belongs only in the transcript. Answer controls contain the
choices and permitted custom-answer fields, not another copy of the question,
visible or hidden. Requests with several fields number their answer groups to
match the transcript.

Task execution, task planning, helper sessions and autonomous scheduled runs
use unattended policy. Copilot excludes `ask_user`; OpenCode denies `question`;
Codex disables ordinary `request_user_input` and denies both question variants
through a session-owned native `PreToolUse` hook. These controls apply on creation
and cold resume without changing YOLO permissions or global harness settings.
OpenCode preserves existing root permissions on resume and reapplies question
denial to owned persisted descendants, preserving their other permission rules
and leaving unrelated sessions untouched.
Native Mesh workers must advertise session question-policy support; update a
worker that reports this capability as unsupported.

Codex can advertise `request_user_input_async` independently of the ordinary
tool gate. In interactive chats its question is nonblocking and its answer is
a normal conversation input, not a callback. An answer waiting in the input
queue remains **Answer queued** in the transcript and exports, not answered.
Removing a definitely unsent reply leaves its attempted message as **Answer not
sent** and makes the question answerable again. A rejected steering attempt
remains queued until dispatched or removed; queuing the same answer again does
not duplicate it.

Steered question answers show the normal native admission indicator and update
automatically as native delivery is confirmed. Native acceptance alone leaves
delivery unconfirmed; only a delivered receipt confirms it. Unknown admission
blocks removal and resubmission, including after reload or reconnect.
**Stop** does not discard queued conversation inputs or turn an uncertain
admission into a safe retry.

Unattended sessions deny invocation
of `request_user_input`, `request_user_input_async` and the native legacy alias
`send_user_message_async` before execution. Only Clanky's own hook is trusted;
other hook trust decisions and YOLO permissions remain unchanged. A Codex
profile that disables hooks or permits only managed hooks cannot enforce this
policy and is rejected explicitly for unattended execution. Unexpected native
human-input callbacks are rejected or cancelled, never answered automatically.
Tasks that need missing human information use the existing blocked outcome.
ACP has no universal tool-exclusion mechanism; unsupported replies are explicit
errors.

Reloading the browser, reconnecting or opening the chat on another device
retains answerable pending questions while the native request is still alive.
A reconnect does not abort that execution; blocking questions keep the chat
waiting. **Stop** cancels pending questions. Losing the underlying native
request or replacing its connection can still expire them.
Expired questions no longer show an answer form or a separate expiry notice.
An unconfirmed answer delivery must not be resent blindly; reconnecting does
not clear that uncertainty or submit the answer again, including when answer
delivery and reconnect overlap. Copilot's legacy callback
supplies no child identity, so its question is not falsely attributed to a
particular subagent. Questions from an identified child are labeled as subagent
questions. Attempted answers show their delivery state in the transcript;
uncertainty remains visible even if the request later expires.

## HTTP and CLI

These user-owned routes use the normal authentication and browser same-origin
policy. Read input identities and receipts from the entity snapshot rather than
inventing IDs or calling Steer repeatedly.

New question requests include optional `transcript` references
(`questionMessageId`, `answerMessageId` and, once submitted, `answerTimestamp`).
Their transcript messages use the normal `assistant`/`user` roles and carry
optional `question` metadata (`requestId`, `scope`, `status`). Delivery updates
retain the same message IDs. For asynchronous questions, `questionMessageId`
identifies the completed transcript segment; `scope.native.messageId` retains
the original native message identity even when the response spans several
segments. Continuations sort after the submitted answer even when the native
event timestamp is earlier or equal.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/chats/:id/activity` | Read native chat activity |
| GET | `/api/tasks/:id/activity` | Read native task activity |
| POST | `/api/chats/:id/activity/:activityId/stop` | Stop one owned chat activity |
| POST | `/api/tasks/:id/activity/:activityId/stop` | Stop one owned task activity |
| POST | `/api/chats/:id/questions/:requestId` | Answer one current native question |
| POST | `/api/chats/:id/queued-messages/:messageId/steer` | Steer an existing queued chat message |
| POST | `/api/chats/:id/queued-messages/:messageId/reconcile` | Recover native chat input delivery |
| POST | `/api/chats/:id/continue-from-history` | Explicitly create a fresh native session using a temporary export of the persisted chat history |
| POST | `/api/tasks/:id/pending-inputs/:inputId/steer` | Steer the current pending task input |
| POST | `/api/tasks/:id/pending-inputs/:inputId/reconcile` | Recover native task input delivery |

For task queueing, use `PUT /api/tasks/:id/pending-prompt` with
`{ "prompt": "...", "attachments": [] }`. `POST /api/tasks/:id/pending` uses the
existing interrupt-first behavior and is not the queue-only path.

```bash
clanky api chats/<chat-id>/activity --method GET
clanky api tasks/<task-id>/pending-inputs/<input-id>/steer --method POST
clanky api tasks/<task-id>/pending-inputs/<input-id>/reconcile --method POST
```

Activity responses contain `activity`; Stop responses contain `result`.
Steer/reconcile responses contain `admission` and the current entity state.
See the [API reference](API.md) and `clanky schema` for the running contract.
