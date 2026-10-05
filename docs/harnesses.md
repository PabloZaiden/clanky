# Harness adapters, activity and steering

## Workspace configuration

Choose the adapter in the existing workspace settings page. Tasks and chats
continue to choose a model and variant from that workspace's harness catalog.
Clanky scheduled Agents inherit the same execution behavior; they are not
harness subagents.

| Adapter | `agent.adapter` | `agent.provider` | Runtime |
| --- | --- | --- | --- |
| GitHub Copilot | `copilot` | `copilot` | Installed and authenticated Copilot CLI; validated with CLI 1.0.91 and SDK 1.0.15 |
| Codex | `codex` | `codex` | Installed and authenticated Codex CLI 0.159.2 or newer, using app-server |
| OpenCode 2 | `opencode2` | `opencode` | Installed `opencode2` runtime, version 2.0.20 or newer in generation 2 |
| ACP | `acp` | Selected harness preset | Existing ACP-capable Copilot, Codex, OpenCode, Claude, Pi or Grok integration |

Native adapters are experimental. Install and authenticate the harness on the
selected execution host, not necessarily on the controller. The Clanky server
or worker must be able to find its CLI in the configured `PATH`. Native startup
does not install or upgrade the harness automatically. Automatic Devbox
workspaces are the exception: their persistent hook manages the selected native
CLI in a private workspace prefix. See
[automatic workspace runtimes](mesh-worker.md#automatic-workspace-runtimes).

Local hosts and end-to-end Mesh generation-6 paths support native adapters.
Direct SSH and Mesh paths with a generation-5-only worker or relay support ACP
only. A relay hop negotiated at generation 5 also remains ACP-only even if the
relay advertises generation 6; missing negotiated-hop metadata fails closed.
A native failure does not switch to ACP; select ACP explicitly when that
is the desired integration. See [Mesh workers](mesh-worker.md) for negotiation
and rollout details.

Existing workspace settings migrate to ACP with their original harness preset.
Selecting a different adapter does not reinterpret a saved session ID. Start a
new conversation when changing adapters; app transcript history is preserved.
Clanky resumes its own sessions, but no longer imports external harness sessions
or offers conversation forks.

OpenCode 2 uses a separate profile under the Clanky data directory. It does not
upgrade an existing OpenCode generation-1 data directory in place. Configure
the required providers for that profile or through the execution-host environment.

## Activity and individual Stop

Open **Activity** from the existing task or chat action menu. Inside a task's
Chat tab, **Chat activity** targets the attached chat; the task's **Activity**
action targets task execution. Returning preserves the composer draft and
transcript position. Related tool rows show compact background-work status and
an Activity link without adding a permanent panel.

Activity updates automatically, including after the principal turn finishes.
Subagent rows show their title, reported model and status. **Stop** targets that owned activity, not the principal,
siblings, worker or independently managed Clanky terminals/previews. A
`stopping` or `unknown` result is not confirmed termination.

An unavailable or partial observation does not prove that no work is running.
ACP does not advertise native activity or steering. A principal response can
finish while native background work remains observable.

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

`accepted` means native admission, not delivery or model obedience.
`delivered` means native history confirms the message. An `unknown` admission
retains the input and blocks deletion, replacement or blind resend. Use
**Check delivery** to reconcile against the original owned native conversation.
Codex can recover by the canonical input/client ID even if the admission reply,
native message ID or turn ID was lost.
Deterministic pre-admission validation errors retain their typed error and mark
the input as rejected, so it can be corrected or removed. For example, Codex
does not accept inline non-image binary attachments such as PDFs; those failures
are not uncertain deliveries.

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
a normal conversation input, not a callback. Unattended sessions deny invocation
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
retain the same message IDs.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/chats/:id/activity` | Read native chat activity |
| GET | `/api/tasks/:id/activity` | Read native task activity |
| POST | `/api/chats/:id/activity/:activityId/stop` | Stop one owned chat activity |
| POST | `/api/tasks/:id/activity/:activityId/stop` | Stop one owned task activity |
| POST | `/api/chats/:id/questions/:requestId` | Answer one current native question |
| POST | `/api/chats/:id/queued-messages/:messageId/steer` | Steer an existing queued chat message |
| POST | `/api/chats/:id/queued-messages/:messageId/reconcile` | Recover native chat input delivery |
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
