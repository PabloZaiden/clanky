# Harness adapters, activity and steering

## Workspace configuration

Choose the adapter in the existing workspace settings page. Chats
continue to choose a model and variant from that workspace's harness catalog.
Clanky scheduled Automations inherit the same execution behavior; they are not
harness subagents.

| Adapter | `agent.adapter` | `agent.provider` | Runtime |
| --- | --- | --- | --- |
| GitHub Copilot | `copilot` | `copilot` | Installed and authenticated Copilot CLI supporting protocol 4 |
| Codex | `codex` | `codex` | Installed and authenticated current Codex CLI, using app-server |
| OpenCode 2 | `opencode2` | `opencode` | Installed current `opencode2` runtime for generation 2 |
| Claude Agent | `claude` | `claude` | Installed Claude Code CLI, controlled through the Claude Agent SDK |

Native adapters are experimental. Install and authenticate the harness on the
selected execution host, not necessarily on the controller. The Clanky server
or worker must be able to find its CLI in the configured `PATH`. Native startup
does not install or upgrade the harness automatically. Automatic managed
workspaces are the exception: their persistent hook manages the selected native
CLI in a private workspace prefix. See
[automatic workspace runtimes](mesh-worker.md#automatic-workspace-runtimes).

Local hosts and end-to-end Mesh v7 paths support native adapters. Every
controller, relay, and worker on a Mesh route must use v7 over TLS.
A native failure does not switch adapters. See [Mesh workers](mesh-worker.md)
for setup details.

New workspace creation defaults to native Copilot; generic server settings
default to native OpenCode 2. Install and authenticate
the selected native runtime on the execution host before starting work.
Existing transcripts and saved conversation identities are preserved.
Selecting a different adapter does not reinterpret a saved session ID. Start a
new conversation when changing adapters; app transcript history is preserved.
Clanky resumes its own sessions, but no longer imports external harness sessions
or offers conversation forks.

Direct execution-host chats store their selected native adapter separately
from the model's upstream provider. OpenCode catalogs can therefore expose
models from providers such as OpenAI or Anthropic without changing the harness.

Chats have the same Mesh worker isolation: maintenance on another
worker does not close their sessions. If their own worker is revoked or its
route becomes invalid, the interruption remains visible and native prompts
are not automatically resent. See
[independent worker lifecycle](mesh-worker.md#independent-worker-lifecycle).

If a native provider confirms a chat turn has finished but never confirms the
completion of one or more streamed messages, Clanky keeps the received text
and lets the chat continue. This applies to intermediate messages and the last
answer alike; retained text may be incomplete. The anomaly is recorded only
as a server warning, not an on-screen error or warning. The messages remain
unconfirmed until a real completion or native-history recovery reconciles
their original identities. Starting another message mid-turn is not itself
an error: messages can interleave and complete later. Late text continues its
original message without changing a newer turn's state; an empty completion
does not erase already received text. Retained updates use bounded checkpoints
and are saved before observation closes. Connection loss,
explicit provider failures and failures to save content remain errors.

OpenCode 2 uses a separate profile under the Clanky data directory. It does not
upgrade an existing OpenCode generation-1 data directory in place. Configure
the required providers for that profile or through the execution-host environment.

Owned native chats and managed Automation runs support
[Clanky Control](control-chats.md) in their workspace without Quick Chat setup
or general access. Explicit general access permits broader application control
within the user's permissions. Native adapters discover their granted catalog
from the shared control boundary and invoke it with scoped execution authority;
they do not call arbitrary application routes with broad API keys.
The control connection is separate from `CLANKY_BASE_URL` and CLI credentials.
Local control dispatches to the common core; Mesh control reuses its native
lease's event/RPC infrastructure over direct TLS or a relay. Control readiness
precedes provider connection and needs neither a callback endpoint nor CLI
credentials. See
[Mesh control transport](mesh-worker.md#execution-owned-control-tools) for
upgrade requirements.
Codex registers these tools only on newly created native threads. Existing
threads resume with their previously registered catalog and history, without
catalog-change refusal, replacement threads or an MCP fallback. Invoked actions
still require current server authorization and valid common-control inputs.
Codex context compaction alone does not require starting a new session.

Copilot uses Microsoft Copilot SDK v2 with an explicitly spawned CLI process.
CLI 1.0.113 supports the required SDK protocol 4; protocol-3 runtimes are
incompatible. Upgrade the Clanky binary and Copilot CLI on each execution
worker together; updating only the controller does not update a remote worker's
SDK. Existing native session identities and authentication are preserved.

Provider subprocesses do not inherit `CLANKY_BASE_URL` or `CLANKY_API_KEY` from
the server or worker environment. Other environment variables and
provider authentication are preserved. Personal keys and interactive terminals
are unchanged. Deterministic programs retain scoped control through their
controller-owned runner adapter.

For OpenCode 2, Clanky loads a managed native plugin and private loopback bridge on
the execution host; no separate plugin installation or MCP
configuration is needed. The installed runtime must support the generation-2
Promise plugin API, including tool reload. Actual chat roots discover optional
browser tools using their persisted real chat ID; scheduled-run roots do not claim a
chat identity. The plugin reloads newly discovered tools before the native
prompt is prepared and filters each model context to that owned root's catalog.
Plugin activation and execution-owned control readiness are checked
before admitting a Control conversation. Tools belong only to an active owned
root turn; native subagents do not inherit them. Scheduled-run
question policies remain unattended, and human control approval remains a
separate pending interaction.

[Live voice](voice.md#live-voice) is a global sidebar assistant, independent of
OpenCode, Quick Chat and any selected chat or native adapter.

### Claude Agent

Install and authenticate Claude Code on the selected execution host, with
`claude` available in its `PATH`. Select **Claude Agent** in the workspace or
direct execution-host chat settings. Models and reasoning options come from
the native catalog and the host's Claude Code configuration.
For Mesh execution, upgrade the worker to a build with Claude support.
Upgrading only the controller does not enable Claude on an older worker.

Claude supports streaming conversations, session resume, interruption,
active-session steering, and native subagent activity and history. Clanky
resumes only its own conversations. Input admission does not mean inference
has completed, and uncertain delivery is never replayed automatically.
Token usage reflects cumulative native counts rather than context occupancy.

Filesystem and shell permissions follow the existing automatic-approval
policy. Interactive questions use Clanky's chat forms and are denied for
unattended execution. Clanky Control and private CLI-secret tools belong to
the active owned root turn, not its subagents. Images opened by native tools
appear as ordinary transcript attachments.

## Private secrets for CLI commands

Interactive native Copilot, Codex, OpenCode 2 and Claude Agent chats on POSIX
execution hosts provide `clanky_request_secret`. It is a host-local native
tool, not a Control operation, approval or tool-to-tool secret reference.
It needs no general-access grant. Native subagent calls are unsupported.
Autonomous scheduled runs and helper conversations do not receive the tool
and cannot access its cache.

The agent supplies a nonsecret `identifier`, `label` and `reason`. On a cache
miss, the same native invocation waits for the user's private chat form, with
no human-input deadline. Replies use the same user/resource authorization,
workspace delegation and browser same-origin protection as ordinary chat
questions, following the server's configured authentication policy. No
passkey-specific sign-in is required. The private reply endpoint is excluded
from agent tools. Closing the browser tab does not cancel the request.
Stop, turn completion or native session loss does.
Supplying a value resumes the invocation automatically, returning only
`{ status: "saved", path, expiresAt }`, with expiry in Unix milliseconds.
Declining returns `{ status: "declined" }`.

Call the tool each time the CLI needs that secret, reusing the logical
identifier. Within the same user, Clanky conversation and execution-host binding,
a valid cached file returns the same path and expiry without another prompt.
Files last **24 hours from successful storage**; cache hits do not extend that
deadline. Missing, invalid or expired files prompt again. Files contain plaintext,
protected by filesystem permissions rather than vault encryption. They live
outside the repository and attachment directories, with random names, `0700`
directories and `0600` files. The execution host checks expiry at lookup, sweeps expired
files every minute and removes abandoned process generations on startup,
including after an abrupt restart. Lifetime-held ownership locks preserve
another live instance's files without trusting a possibly reused PID.
Ordinary turn completion and backend reconnect do not remove cached files.
Startup and deletion failures are reported, not treated as successful cleanup.

In Mesh, the worker creates and owns the file; the controller never makes a
local copy. Secret values travel only through private browser/host reply paths,
not ordinary question answers, transcripts, attachments or model tool inputs
and outputs. Multiline text and whitespace are preserved. Private input uses
the same request-body reading as ordinary chat text, without a secret-specific
size limit; general server and transport limits still apply.

Prefer a CLI's stdin or file option. For environment-only CLIs, read the file
inside the command, for example `GH_TOKEN="$(cat -- /private/path)" gh api user`.
Never print the value, enable shell tracing or copy it into the repository.
This keeps secrets out of Clanky's conversation history; it is **not a sandbox
against agent commands or other processes running as the same OS user**.
A CLI can still print, transmit or persist the credential. Deleting the file
neither revokes the credential nor guarantees forensic erasure.

Codex registers the tool only on new native threads; resuming an old thread
does not replace its tool catalog or start another conversation.

## Provider limits and continuation

Recognized provider quota exhaustion and terminal rate limits show a blocked
chat instead of a generic runtime failure. The original diagnostic stays
visible. Codex, Copilot, Claude Agent and OpenCode 2 use their native structured
error signals; available retry times come from Copilot quota observations,
Claude quota events and OpenCode error metadata. An unknown reset time is not
presented as a countdown.
Provider-owned retries remain in charge while their native turn is running.
Older generic failures are not retroactively reclassified or automatically
scheduled.

Use **Continue now** to continue the same native conversation after resolving
the limit. **Continue automatically when available** authorizes continuation
only for the current interruption, including project actions while the browser
is closed. The schedule survives controller restarts. Uncheck the option to
cancel pending continuation; Stop, Done, Trash and a new manual message also
cancel it. Stopping an execution that has already started still uses Stop.

Automatic continuation honors the provider's retry time. Without one, attempts
are spaced 1, 5, 15 and then 30 minutes apart, stopping after 12 attempts.
Billing issues requiring intervention cannot enable automatic continuation.
Changed account access, host, adapter or model, missing sessions, unresolved
inputs, and execution that cannot be confirmed inactive stop continuation
visibly. Continuation submits a new instruction to inspect current progress;
it never replays the interrupted prompt or tool calls and never switches
providers. If delivery becomes uncertain, check the chat before continuing
manually. This feature does not retry scheduled Automation runs.

## Diagnosing provider failures

For a failed chat, read `state.harness.lastFailure` from its existing chat API
response and search its diagnostic `id` in the controller logs. For Mesh,
search the same ID in the execution worker's logs; nearby request and lease
IDs connect it to transport records. Upgrade both controller and worker to
capture the complete path. Old generic errors cannot be reconstructed.

Diagnostics retain the operation, adapter, allowlisted native codes, available
HTTP/RPC status and bounded cause/source locations. Arbitrary exception text,
RPC data, HTTP bodies, headers, prompts and full filesystem paths are excluded
from these structured records. Existing provider-facing messages are separate.
When reporting a failure, include the diagnostic, build versions and relevant
correlated log entries, not credentials or conversation payloads.

`lastFailure` is the latest recorded failure, not proof that the chat is still
failed; it remains available after recovery and controller restart. A diagnostic
does not confirm input admission, authorize a retry or establish that a later
disconnect caused the original failure. Check unresolved delivery before
continuing an uncertain request.

## Continue from history

When a chat is failed because its provider-native session cannot be resumed,
use **Continue from history** to explicitly create a new native session for the
same Clanky chat. Ordinary reconnect still resumes the original session; Clanky
does not replace, interrupt, or delete it automatically, and it may still exist.
The chat transcript and chat ID remain unchanged. History continuation is
blocked while the chat has an active run, queued input, unresolved delivery,
question, or permission request.

For workspace chats, history continuation uses the workspace's current execution
host, even if the old session belongs to a previous host. The replacement session
and saved chat binding use that current host. Direct execution-host chats keep
their explicitly selected host.

The chat directory must already exist on the destination host. A managed chat
worktree must be registered there and retain its recorded branch; recovery fails
explicitly if these resources are missing or the branch differs. History
continuation does not clone repositories or transfer worktrees or uncommitted
files between hosts.

Before the new session handles its first message, Clanky writes the persisted,
user-visible transcript as JSON Lines to
`<chat-directory>/.clanky-chat-history/<chat-id>/<recovery-id>/conversation.jsonl`
on the selected execution host. Images are stored in the sibling
`attachments/` directory and referenced by relative path. Non-image files use
absolute paths in the durable conversation attachment directory, which is not
removed with the temporary history export. The managed export is
excluded from Git. The new agent receives the export path and is asked to read
it incrementally as untrusted context; old requests, uncertain or queued input,
and tool actions are not replayed.

The export is removed after the first continuation completes successfully or
when the chat is deleted. It cannot be used after its 24-hour expiry. Expiry is
not a background deletion job: physical cleanup is attempted when the export
is next used/replaced or during chat deletion. If an earlier export's host is
unavailable, recovery on another host keeps its cleanup metadata without
blocking the replacement session. Cleanup is retried on later continuation,
recovery, and deletion, using the original export's host binding. Unreachable
or revoked hosts can retain files; recovery never redirects their cleanup to
another host or bypasses binding revisions.

## Token consumption

The chat composer's **Conversation options** panel shows **Usage** above
**Template**, with three rows: **Input tokens**, **Output tokens**,
and **Cached**. Cached is the percentage of total input read from the prompt
cache; cache writes are not included in that percentage. It is unavailable
when input is zero or either required counter is missing. Counts use decimal
**K**, **M**, and **B** abbreviations; the exact count is available in the
value's tooltip and accessible label. Changed displayed values pop in over
800 ms unless reduced motion is enabled.

Clanky stores cumulative consumption for native Copilot, Codex, OpenCode 2 and
Claude Agent sessions, including observed subagents when exposed by the provider.
Input, output, reasoning, cache-read and cache-write counts are retained when
available. Input includes
cached input; output includes reasoning, which is also recorded separately.
These categories overlap: do not add reasoning to output or cache to input
again. Token counts are not context-window utilization or a billing estimate.

Checkpoints run server-side every 5 seconds while a native session is
connected and when a principal or child turn ends, including interruption and
failure. Periodic ticks skip an in-flight read; turn-end checkpoints still
queue a final read. They do not depend on an open browser or menu. Providers may only
finalize their counters at model-call boundaries. Saved totals survive Clanky
restart, reconnect and replacement of a native session. Repeated cumulative
snapshots do not count as additional consumption.

Chat teardown settles owned native work before the final usage
checkpoint and transport release. If settlement or the final refresh fails,
the retained total is marked **Last known** instead of implying complete
final accounting.

Scheduled Automation runs share
their backing chat's accounting rather than counting a second execution.
Consumption is private to the entity owner. On Mesh, the controller requests
usage only when the worker advertises token-accounting support; update older
workers to enable it.

**Partial** means some consumption could not be recovered, such as a Codex
thread whose usage notification has not been observed. **Last known** means
refresh failed; the saved number is retained instead of being reset to zero.
A dash means no consumption count is available. Old usage cannot be
reconstructed when the native provider no longer exposes it.

## Activity and individual Stop

Open **Activity** from the chat action menu.
Returning preserves the composer draft and
transcript position. Related tool rows never show inline activity status
labels. They show only an **Activity** link while any associated activity is
running; otherwise, no inline activity summary is shown. No permanent panel is
added.

Activity updates automatically, including after the principal turn finishes.
Subagent rows show their title, reported model and status. **Stop** targets that owned activity, not the principal,
siblings, worker or independently managed Clanky terminals/previews. A
`stopping` or `unknown` result is not confirmed termination.

An unavailable or partial observation does not prove that no work is running.
A principal response can
finish while native background work remains observable.

### Saved subagent conversations

Select a subagent's name in **Activity** to read its conversation with the
normal chat presentation, including Markdown, reasoning, tool details and
available images. There is no composer or child-send action. **Back to
activity** restores the list; returning to the parent preserves its draft,
scroll and selected tab. Known nested subagents show their originating child.
Stop remains a separate native activity action, not a transcript action.

Clanky captures identified children on the server while observing their
parent session, including between principal turns, without an open browser.
Saved children remain listed after completion, native inventory changes,
restart or worker disconnect. Reading saved content does not reconnect the
provider or start work. Children inherit their parent's access and retention:
Trash hides them, restore makes them readable again, and permanent parent
deletion removes them. They are not standalone chats or sidebar entries.

Copilot, Codex, OpenCode 2 and Claude Agent expose child history through their
public native APIs; compatible Mesh workers support the same capture. Instructions and
reasoning are retained only when exposed, not reconstructed from delegation
summaries or hidden context. Recovery is paginated and reconciles stable native
identities with already saved content. Large messages do not invalidate recovery
or have to fit a page's batching target. **Partial history** means some content
is unfinished, missing or unavailable from the provider. Disconnected
observation is separate from execution status and does not imply completion.
Missing native start boundaries or omitted generated images keep coverage
partial. Transient recovery failures retry with bounded backoff while the
parent is observed; no browser is required. Child failures and informational
question/permission notices remain visible in the conversation, but answers
and decisions still belong to the parent.
Older Mesh workers can still serve content already saved on the controller;
update the worker to enable native child-history recovery.

Chat streaming follows the principal execution, not the lifetime of background
processes. When the principal finishes, the chat becomes idle and accepts a new
message normally, even if a background server is still running. Those processes
remain visible and controllable in **Activity**; finishing a turn does not stop
them. Native chat observation stays attached to the owned conversation between
turns. If a background result starts another principal execution, its messages,
tools and questions are saved in the same chat without another user message.
This does not depend on keeping the chat open.

Copilot uses its principal `assistant.idle` signal rather than waiting for
session-wide idle, which only refreshes activity and never completes a prompt.
Codex and OpenCode use their principal execution completion signals. **Steer**
only applies while the principal is actually executing. Ordinary messages queue
while that principal is working, including autonomous continuations. A native
execution starting during admission is a busy conversation, not an invalid
model selection. Unchanged model settings are not reapplied to active work;
actual model changes wait for a safe execution boundary.
Ordinary input is durably reserved before native submission. A definite busy
rejection leaves it queued; a lost acknowledgement leaves its delivery unknown
and prevents an automatic resend. Successful admission records the user message
and clears the corresponding queue and reservation together.

On native chat reconnection, Clanky subscribes before reading the provider's
persisted conversation history. Copilot, Codex, OpenCode 2 and Claude Agent use
their native history APIs to reconcile completed principal messages and tools by their
stable identities. Recovery does not rerun tools or resend prompts, and does
not promise to restart work stopped with the provider runtime. Missing,
unsupported or over-limit history produces an explicit observation failure
rather than silently reporting a complete transcript. Local and native Mesh
conversations follow the same rules; a Mesh worker must advertise native history
recovery support.

Native messages have independent lifecycles identified by their provider IDs.
Several messages may be streaming before any of them completes; reasoning,
tool events and another message's completion do not replace their pending text.
Chat switches checkpoint the outgoing block
without closing it, so interleaving does not create extra transcript segments.
Authoritative completions reconcile only their own message and transcript
segments. Clanky never merges different message IDs because their text matches.

Unfinished native responses retain bounded, durable message checkpoints.
Reconnection reconciles completed provider messages by ID and preserves any
remaining partial text without treating it as a completed provider message.
An interrupted response does not need a final provider record to allow the
original conversation to reconnect and accept new input. Clanky does not resend
the interrupted request or guess which other message replaces it.
Missing or invalid durable history still fails explicitly. Confirmed normal
prompt completion with unfinished messages preserves the received content and
logs a warning, as described above; it does not fail the chat. An
integrity/history observation failure cancels the unobserved principal with a
bounded abort wait and disconnects its runtime if cancellation fails.

A native transport closure alone is a disconnection, not a failed conversation.
A completed idle chat remains idle after a normal restart, `SIGKILL`, or container
loss, without requiring a new message to clear a false error. An interrupted
principal is stopped, not reported as successful; incomplete responses and
uncertain input delivery remain available for reconciliation. Genuine provider,
ownership and history-integrity failures remain explicit.

For native Mesh chats, a worker restart that ends the event stream cleanly, or
an explicitly identified relay transport interruption, preserves the idle
principal's result and original session binding.
Background observation becomes unavailable with reason `disconnected`, not an
empty successful inventory or evidence that background work survived. Resume
the original conversation once the worker returns. Event framing, sequence and
history-integrity failures remain errors rather than transport disconnections.
For ambiguous direct HTTP connection errors, one bounded read-only health
request checks the same trusted worker route. An unreachable worker is treated
as disconnected; any HTTP response preserves the original observation error.
Unclassified failures, relay dispatch failures and rejected relay tickets
remain errors. The existing stream protocol cannot recover a discarded worker
error code or prove the cause of every interrupted read.

Copilot streams and final messages use the SDK's message identities, including
responses split around reasoning boundaries. Empty reasoning/tool-only messages
have their own lifecycle and cannot clear another message's pending response.
Shutdown-cancelled admission remains stopped/disconnected with recovery guidance,
unlike an explicit user interrupt that can return to idle. Queued native input
preserves that recovery state on transport loss. Admitted question and permission
replies, including their resulting state writes, drain before backend teardown.

Startup invalidates saved connection and available-activity projections.
Disconnected activity is unknown, not an empty list of background work. Resume
reconciles the original conversation before accepting another prompt. This does
not guarantee that background work survives the death of its execution runtime
or container; clean shutdown is an optimization, not a recovery requirement.

OpenCode also retains observed foreign or unattributed shells in the selected
directory as unverified external activity.
Clanky does not stop them individually or during owned cleanup.

## Queued input and Steer

Queue a message as before. When the active native adapter supports it, use the
small **Steer** text action beneath that queued input to inject it into the
current execution. This does not cancel/restart the turn or switch its model.
Ordinary queueing and interrupt-and-send remain separate actions.

A message can include up to 20 attachments. Each attachment is limited to
20 MiB per file and 60 MiB total per provider turn. The total includes messages
grouped from the queue and images steered into an active turn.

Only PNG, JPEG, WebP and GIF are sent inline. All other attachments, including
TXT, Markdown, PDF, archives and unknown formats, are copied unchanged to the
actual execution host and referenced by absolute path. Clanky does not parse
their content or require provider-native document/embedded-context support.
The agent chooses its own tools; acceptance of a file does not guarantee the
model can interpret its format. [Attachment storage and lifecycle](attachments.md)
also apply to Automation runs.

`accepted` means native admission, not delivery or model obedience.
`delivered` means native history confirms the message. An `unknown` admission
retains the input and blocks deletion, replacement or blind resend. Clanky
reconciles unresolved admission automatically against the original owned native
conversation while the chat is open; status updates appear without a
manual check. Transient failures retry automatically. Permanent request
failures stop automatic retries and expose a **Retry check** recovery action
that only reconciles the existing receipt; it never resends the input. Leaving
and reopening the entity resumes reconciliation.
Deterministic pre-admission validation errors retain their typed error and mark
the input as rejected, so it can be corrected or removed. File preparation
finishes before native admission is recorded; a failed copy is not an
uncertain delivery and does not consume queued input.

## Provider-generated images

Codex image-generation results and inline image blocks returned by providers are
shown as separate assistant messages with image attachments. The image bytes
are removed from tool output, so an image is not represented by a tool-call row.
Clanky validates the actual image bytes against the existing PNG, JPEG, WebP and
GIF allowlist, including Base64 integrity and decoded size. Generated output
does not inherit user-upload byte, image-count or per-turn quotas. Unsupported
or malformed images are omitted with a warning while the provider's text
response continues.

Copilot tool images in `binaryResultsForLlm` use this same image pipeline.
Native recovery resolves durable image references through Copilot's own binary
event log rather than losing the image or retaining its Base64 in tool output.
Local and Mesh output have no fixed event-size ceiling. Mesh sends large
images/results across the existing transport fragments and flow-control window;
a fragment limit is not a result-size limit. Existing execution-host image-file
references are still validated against the returned file's metadata and bytes.
Update both controller and worker to remove their former event/image ceilings.

Event/relay accumulation has no default count or byte ceiling. Waiting
backpressure remains, but very large output or a producer that consistently
outpaces its consumer can exhaust available memory; removal of these caps does
not provide unlimited physical capacity.

Open an image attachment to preview it, then tap or click the image in the dialog
to open the full image alone in a new browser tab. Clanky preserves the image
bytes received from the provider. The dialog also offers **Download**:
browser clients start a download, the Mac app opens **Save As**, and the
iPhone/iPad app opens the system share/export sheet. Opening the image alone
does not force a download. Starting a download/export does not confirm the
destination saved the file.

## Questions

Interactive chats show native questions inline. Choose an offered option or
enter another answer when the harness permits it, then use **Send answer**.
Multiple-selection requests accept more than one choice. A blocking question
shows the chat as waiting; normal composer messages remain queued rather than
being interpreted as the answer. **Stop** interrupts the pending execution.

New questions appear in the transcript as assistant messages, and submitted
answers as user messages, without opening a tool call. Requests with several
fields remain grouped, with numbered questions and matching answers; an empty
optional field is not treated as an answer. These messages survive reloads,
reconnects and loading older history, and are included in Markdown/HTML exports.
Existing tool details remain available. Earlier question history is not
converted.

While a question is open, its transcript text appears once next to its choices
and permitted custom-answer fields, even if the original position is outside
the loaded history. Requests with several fields number their answer groups
to match their questions. Private secret requests use only their private form.

Helper sessions and autonomous scheduled runs
use unattended policy. Copilot excludes `ask_user`; OpenCode denies `question`;
Codex disables ordinary `request_user_input` and denies both question variants
through a session-owned native `PreToolUse` hook. These controls apply on creation
and cold resume without changing YOLO permissions or global harness settings.
OpenCode preserves existing root permissions on resume and reapplies question
denial to owned persisted descendants, preserving their other permission rules
and leaving unrelated sessions untouched.
Native Mesh workers must advertise session question-policy support; update a
worker that reports this capability as unsupported.

Codex uses blocking clarification questions by default. It can advertise
`request_user_input_async` independently of the ordinary tool gate; use it
when explicitly asking Codex to continue while it waits for an answer. Its
answer is a normal conversation input, not a callback. **Send answer** automatically
steers that reply into the active native turn; it does not wait for that turn
to finish or require a separate **Steer** action. Ordinary composer messages
continue to queue normally. If the turn has finished, the answer starts a new
turn through normal input dispatch. An answer waiting in the input
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
| POST | `/api/chats/:id/activity/:activityId/stop` | Stop one owned chat activity |
| POST | `/api/chats/:id/questions/:requestId` | Answer one current native question |
| POST | `/api/chats/:id/queued-messages/:messageId/steer` | Steer an existing queued chat message |
| POST | `/api/chats/:id/queued-messages/:messageId/reconcile` | Recover native chat input delivery |
| POST | `/api/chats/:id/continue-from-history` | Explicitly create a fresh native session using a temporary export of the persisted chat history |

```bash
clanky api chats/<chat-id>/activity --method GET
clanky api chats/<chat-id>/queued-messages/<message-id>/steer --method POST
clanky api chats/<chat-id>/queued-messages/<message-id>/reconcile --method POST
```

Activity responses contain `activity`; Stop responses contain `result`.
Steer/reconcile responses contain `admission` and the current entity state.
See the [API reference](API.md) and `clanky schema` for the running contract.
