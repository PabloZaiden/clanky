# Voice input, Live conversations and spoken playback

Clanky uses the configured OpenAI-compatible provider for audio transcription
and for generating concise spoken summaries. Text-to-speech runs locally on the
Clanky server with Piper.

When summary playback is available, the `Read summary` control appears as soon
as an assistant message contains text, including while the response is still
streaming. Playback started mid-stream summarizes the text available when
clicked; later response text is not appended.

## Provider settings

In **Settings → Voice**, configure the provider URL and API key, a transcription
model, and a text-generation model. These are needed for voice input and
summary playback and transcript translation. Validate transcription, text
generation, and Live Voice after changing their settings. One **Save** persists
the whole form, including optional independent Live credentials; it does not
automatically validate any capability. Use **Validate** beside each model on
saved values. **Cancel** discards the draft; navigation asks before discarding
unsaved changes and failed saves retain the draft.

Blank key fields preserve saved keys. Use the explicit remove-key checkbox and
Save to clear a key. Provider and independent Live keys are cleared separately.

Assistant response blocks in chat, task, and agent-run transcripts can be
translated to English or Spanish. Translation sends the selected block's text
to the configured, validated shared text-generation model. Clanky returns the
result to the browser for display in that block only; it does not modify or
persist the original conversation. The configured provider receives the
selected text and applies its own data handling.

The `languageHints` setting applies to provider-backed transcription. Piper
detects the speech text's language locally and does not use those hints.

The single text-generation model must support **Responses API**. Capability
validation, spoken summaries, and Live delegation use that same configured
model. Voice-provider requests use `/v1/responses` (Azure:
`/openai/v1/responses`), with the model or deployment name in the request body.
Clanky does not fall back to Chat Completions. Transcription routing is
unchanged.

Shared text generation explicitly requests `reasoning: {"effort":"none"}` for
validation, translations, Piper summaries and Live delegation. The provider
must support this setting; Clanky does not silently retry with model-default
reasoning. This does not change independent workspace agents' model preferences.

## Live voice

Live is a **global Clanky assistant**, separate from **Talk** (record,
transcribe, send), Piper read aloud, Quick Chat and native Control chats.
Start it with the microphone button immediately left of Quick Chat in the
sidebar, including on Home with no chat selected. No workspace agent or native
adapter is required. Triple-click or triple-tap a non-interactive area of a chat
transcript to start Live too. This gesture no longer starts Talk.

The assistant can discover your chats, tasks, workspaces, servers and execution
hosts; read their state and content; create and manage work; send or queue
instructions; answer interactions; and navigate the originating client. Common
intents are available immediately; uncommon operations discover exact per-method
contracts from Clanky's real framework route catalog, not a separate endpoint
list. Existing user ownership, scopes and selected-host
execution still apply. Credential management, raw transports, uploads/downloads
and browser media are not ordinary JSON assistant operations.

Live and its delegated model are instructed to express your requests directly
to the recipient, not narrate them as "the user asks". For example, "Ask the
Backend chat to review the timeouts" becomes "Review the timeouts". This applies
to chat messages, initial messages, task prompts, follow-ups and feedback,
preserving your language, intent, details and constraints without adding
requirements or commitments. Reported speech is reserved for an explicitly
requested quotation, summary or relay of another person's words. Approval
requirements and confirmed-result reporting are unchanged.

In **Settings → Voice → Live Voice**, **Personal instructions** stores up to
**4,000 characters** privately for your user. Use it for language, tone, form
of address, speaking pace, pronunciation, response length and listening style.
For example:

```text
Speak Spanish using voseo. Be calm and direct.
Start with the result; use one or two sentences for routine questions.
Give me time when I pause to think, and use few listening acknowledgments.
```

Save applies these preferences to your **next call**, not a call already in
progress. The text is added as a separate section of the Live model's
`session.instructions`; it does not change the delegated text model's prompt,
workspace agents, tools, permissions or visual approval requirements. Leave
it empty to keep the default behavior. The configured Live provider receives
this text when you start a call; do not include credentials or secrets.

In **Settings → Voice**, configure one transcription model, one shared text
generation model, and one Live model/deployment. Reuse the existing voice
provider URL and saved key, or configure an independent HTTPS endpoint and
encrypted key for Live. When the Live endpoint is independent, both the Live
model and the shared text model must be accessible from that endpoint.

The endpoint must implement GPT-Live with WebRTC, authenticated sideband and
Responses delegation, not merely offer a compatible `/responses` route.
Compatible URL roots include `https://api.openai.com/v1` and an Azure OpenAI
resource with `/openai/v1`. There is no Azure-only model or workspace setting.
For Azure, use the deployment names. Live validation opens a temporary
WebRTC session, checks authenticated sideband access, and closes the session.
The Settings browser creates a temporary offer with an audio transceiver and
`oai-events` data channel, gathers ICE, then closes its peer. Validation does
not request microphone permission or send audio. Function access is exercised
when the shared text model uses a tool. The provider must support strict
Responses function schemas, including nested `anyOf` navigation variants;
successful connection validation alone does not verify function execution.

Each new call opens expanded in a full-width rectangular bar flush with the
bottom and both edges of the main content area, with no rounded corners or
exterior gaps. Its controls remain inside the mobile safe area.
The desktop bar uses the framework's full sidebar-tabs strip height, including
its padding and border, so their upper dividing lines align exactly.
It overlays whatever screen is open, including its composer, and remains
available across navigation, with the sidebar closed, in a fullscreen terminal,
and on desktop or mobile. It shows
connecting/listening/speaking/processing/muted state, mute/unmute and stop;
connecting can be cancelled. Buttons retain tooltips and keyboard focus feedback.
During delegated lookups/actions, the expanded bar also shows the model's brief
intention in the user's language, when supplied. The description has its own
full-width row on mobile and sits between the status and controls on desktop.
It wraps without clipping or squeezing the controls, with reserved mobile space
even between actions. This is a bounded current-action label, not a transcript,
history or a claim that the work finished.

**Minimize Live voice to sidebar** moves the controls to the existing position
above the sidebar version without ending or muting the call. **Expand Live
voice** moves them back over the main content and dismisses the mobile sidebar.
In minimized mode, open the sidebar to reach the controls. **Stop Live voice**
is a separate action that ends the call. **Mute** disables microphone input
without stopping spoken output. If playback is blocked, use its speaker button
(**Enable Live audio playback**).

The call remains active across in-app navigation in its originating tab. Stop
releases the physical microphone promptly and closes media and sideband without
cancelling delegated chat/task work. To stop that work, request its normal
interrupt/stop operation explicitly. Talk and Piper cannot start while global
Live owns audio. Starting Live stops active summary playback; it reports a
conflict instead of discarding an ongoing Talk recording or transcription.

### Talk from the composer

The composer's three-dot menu ends with **Template** on the left, followed by
spaced SVG icon actions: the microphone starts **Talk**, when available, and
the rightmost paperclip attaches files.
Both keep tooltips and accessible names.
With an empty draft and Talk available, hold the **send arrow** until a
microphone button appears above it. Drag the mouse or finger onto that button
and release to start the same record/transcribe/send flow. Releasing elsewhere,
Escape, or a cancelled pointer gesture dismisses it without sending a message.
A short click still sends normally; holding the three-dot button has no new
gesture. The send-arrow gesture is unavailable while the conversation is
active, another composer operation is busy, or Live owns audio.

Stop the recording to transcribe and send it; cancel it to discard the recording.
Talk still requires an empty draft, including no attachments. Its existing menu
action remains keyboard-accessible.

### Continuing a recent Live conversation

If you start Live again less than **10 minutes after the previous call ended**,
it continues your recent conversation, including references to work you created
or discussed. Each subsequent Stop starts a new ten-minute window; at ten
minutes or later, Live starts a fresh conversation. This works across tabs for
the same signed-in user, but controls always belong to the new originating tab.
Restarting requires an explicit click and never automatically turns on the
microphone. Pending approvals, SSH handoffs and watches do not carry over, and
previous actions are never automatically repeated.

Destructive actions, arbitrary commands, permission changes and autonomous
execution require a **visual approval dialog** in the originating tab. The
dialog shows a short model-written description in the user's language, with
the named target and important consequences, plus **Approve** and **Reject**.
It does not show API endpoints or JSON payloads. The model supplies the text
alongside the actual arguments in the same turn; both are frozen together.
The original API validator, including cross-field requirements, is checked
before approval is requested; hidden browser-supplied inputs are not model
arguments. The server rechecks the target before dispatch. The model cannot
approve the operation or override its arguments after approval. Task creation first
reads the workspace's effective defaults, connected models and real host
branches, then applies explicit intent and the browser's saved preferences.

Registered SSH operations use the existing encrypted browser password store
and a private, call-bound credential exchange. A missing credential opens an SSH
password dialog; cancellation never silently selects another host. Credential
tokens are not function arguments, results or realtime acknowledgements.
Operations requiring different SSH servers through a single-token API are
rejected rather than guessing which credential to use.

### Direct common operations

Twenty-two common intents are available to the textual model before discovery.
Their names below have the `clanky_` prefix:

| Tool | Useful operation |
| --- | --- |
| `recent_work` | Recent chats/tasks by actual activity, with Voice status categories and bounded literal previews. |
| `waiting_work` | Questions, permissions and ready plans awaiting manual approval, with Voice status categories. |
| `list_chats` | Filter chats by workspace, exact name or raw status; results include a Voice status category. |
| `read_chat` | Raw and Voice status, pending interactions and latest or earliest literal conversation. |
| `send_chat_message` | Send one instruction to a named, identified or selected chat. |
| `steer_queued_chat_message` | Steer an existing queued message into a streaming chat execution without resending it. |
| `create_chat` | Create in a workspace or on an execution host; optional initial message and opening. |
| `interrupt_chat` | Interrupt active chat work, independently of stopping voice. |
| `update_chat_lifecycle` | Mark a standalone chat done or move it to recoverable Trash after visual approval. |
| `respond_chat_interaction` | Answer a specific or uniquely pending question, or decide a permission. |
| `list_tasks` | Filter tasks, including Voice status, progress and required-intervention reasons. |
| `read_task` | Raw and Voice status, plus literal conversation, prompt, plan or diff. |
| `create_task` | Create a draft or planning task with actual defaults and model preferences. |
| `instruct_task` | Send a follow-up or set the next-iteration prompt, with explicit intent. |
| `control_task` | Start draft planning or stop execution; not a generic resume command. |
| `review_task_plan` | Give feedback, accept, or discard the plan **and delete its task**. |
| `finish_task` | Accept completed work locally or push it, preserving distinct approval policies. |
| `list_workspaces` | Owned workspace metadata and execution context. |
| `list_servers` | SSH registrations and local/SSH/Mesh hosts, without probing or credentials. |
| `create_workspace` | Create at an explicit directory on a selected host with an explicit adapter/provider. |
| `get_ui_state` | Fresh acknowledged route/selection and relevant browser preferences. |
| `ui_action` | Open a named chat/task/workspace/server/host, or use canonical client actions. |

Read/action targets accept an ID, exact name and optional workspace, or
`current` for the originating client's acknowledged selection. Names are
resolved locally through authorized reads; an ambiguous name returns safe
candidates instead of choosing a match. The model should pass the user's name
directly, not list resources just to obtain IDs. A combined intervention query
uses one `waiting_work` with `kind=all`.

Voice work results preserve the API's raw `status` and add `voiceStatus` for
simple spoken categories. Chats map `streaming` and `waiting` to `active`,
`idle` to `idle`, `done` to `done`, and `starting`, `interrupting`,
`reconnecting`, `stopped` and `failed` to `error`. Tasks map `planning`,
`starting`, `running`, `waiting` and `resolving_conflicts` to `active`;
`idle` and `draft` to `idle`; `completed`, `accepted_local`, `merged`,
`pushed` and `deleted` to `done`; and `stopped`, `failed` and
`max_iterations` to `error`. For broad category questions such as “active
chats”, leave the exact raw `status` filter null and use `voiceStatus`; do not
filter on a made-up raw state such as `working`.
For hosts, `current` requires an execution-host selection; a current server
requires that selection to be SSH. The fresh route's host kind and ID are
matched against authorized resources, never guessed from a name.

Creation resolves real connected models, branches and effective defaults.
Task creation also reads fresh browser planning/model preferences; explicit
overrides include the main and cheap models. Unavailable remembered models
require clarification rather than silent replacement. Workspace creation
requires the execution host, directory and adapter/provider; cloning,
provisioning and other uncovered operations use the catalog fallback.
An explicit worktree request for a directory workspace or a workspace with
worktrees disabled is rejected before visual approval, not silently changed.
Compound chat creation freezes the optional message/open intent and its
additional user-language description in the same visual approval as creation.
Rejection executes no stage. Approved stages are individually authorized and
occupy one mutation queue slot through the navigation acknowledgement. Other
queued writes wait until the compound action completes or fails. Stages return
their outcomes, including partial failure; they are never replayed.

The session has **27 tools**: these twenty-two direct intents, the existing
selective `watch_work`, the three generic find/describe/execute tools for
uncovered intents, and the `clanky_accept_goodbye` lifecycle tool.
Direct tools skip model-side discovery, not authorization, credential exchange
or visual approval. API results distinguish completed operations from admitted or
queued background work. Entity navigation refreshes its shell data and reports
opened only when the originating tab has committed the route and target data.
Selective watches reread authorized state without streaming all chats'
transcripts. Adding several watches either installs the complete authorized
batch or leaves existing watches unchanged. If a mutation's result is uncertain,
inspect its state before repeating it; Clanky never automatically replays mutations.
The execute tool's required `confirmationDescription` is 1–500 trimmed
characters for `confirm` operations and `null` for other automation policies.
It is separate from the ordinary operation's API body.

`update_chat_lifecycle` supports only `mark_done` and `move_to_trash` for
standalone chats. Marking done does not interrupt active work; the chat API
rejects busy or reconnecting chats. Moving a chat to Trash stops active work
and keeps its history and worktree recoverable for 30 days, but requires the
originating user's visual approval. This tool cannot set runtime statuses or
permanently purge chats. Task chats remain task-managed, and agent chats are
excluded because their existing delete path is permanent.

`steer_queued_chat_message` operates only on messages already in a chat queue.
With `messageId: null`, it proceeds only when the chat has exactly one queued
message; if several exist, it returns bounded candidates and requires a
specific ID. Steering requires a streaming execution and a backend that
supports native steering. The result reports admission, not delivery or
completion; do not resend a message when admission is uncertain or rejected.

After a clear farewell (such as “chau”, “chao”, “adiós” or “hasta luego”) or
direct request to finish, call `clanky_accept_goodbye` by itself without a
separate spoken response. Do not call it for an opening greeting or pause; a
verbal promise to finish is not a substitute for the tool call. After calling
it, do not use more tools or add speech.
Delegated chat/task work continues.

Live selects [compact API representations and literal conversation
pages](API.md#compact-reads-and-literal-conversations) from the same route
contracts used by ordinary API/CLI clients. Listings do not carry expanded
runtime state. Large prompts, questions, files and tool outputs use targeted
sections and resumable content parts. Conversation review returns the actual
human-readable exchange, not tool events or an AI-generated summary. The model
must follow `nextCursor` until it is null before claiming complete coverage.
Operation descriptions can also be read as separate query/body contract pages;
large client preferences use route/preferences sections.

Direct conversation reads default to a bounded **latest** selection, not a
walk through the whole history. `omittedEarlierMessages` distinguishes complete
delivery of that selection from complete history. Recent-work previews select
the last two messages. Combined work overviews expose `limitPerKind`, source
coverage and a combined cursor: each source has its own activity-ordered page,
not a global top-N or atomic cross-resource snapshot. Combined server/host
cursors likewise continue unfinished sources without restarting completed ones.
If previews or persisted state are unavailable, the result says so explicitly.

Each delegated response admits at most eight function calls. Clanky budgets
**28,000 UTF-8 bytes for the complete serialized result batch**, including
JSON escaping and provider envelopes, below the provider's 32,768-byte queue.
The API read budget is allocated according to the number of calls in that
batch. Only one batch is queued until the provider acknowledges its next
response, including when delegations overlap. Selected-work observers read
compact status/input counts instead of whole harness snapshots.

An unexpected oversized result explicitly reports that its data was not
delivered while retaining the operation outcome. Inspect the target with a
targeted read; never replay a mutation to recover omitted data. Diagnostics
record canonical tool/operation identifiers, a hashed request correlation and
wire-byte counts, not result bodies or private credentials.

Browser microphone permission, HTTPS (or localhost), provider connectivity and
audio playback permission are required.

### Response latency and feedback

Before delegating a Clanky lookup or action, Live is instructed to speak a brief
acknowledgement, such as "I'll check." It must not claim completion before the
tool result, repeat the acknowledgement for every tool, or read internal API
details aloud. The sidebar's processing state remains visible while a delegation
is pending. Spoken acknowledgement is generated by the Live provider, not a
local prerecorded sound.

Local data access is only part of a voice answer. Operation discovery, contract
description, execution, pagination and the final explanation can require
several separate text-model rounds for uncommon or oversized requests. Direct
intents remove common discovery/description rounds and select recent conversation
locally. One useful tool round normally still needs **two text-model responses**:
the function call and the final answer from its result. Disabling reasoning
does not eliminate those network/model round trips, approvals or remote work.

The server's `core:live-voice-latency` INFO records distinguish:
- Delegation start/end, call ID and hashed delegation correlation.
- Text-response round, admission wait, first output, response duration and
  available input/output/reasoning token counts.
- Canonical tool name and hashed request correlation, queue wait, local
  execution/serialization duration, outcome and serialized result bytes.
- Function-result batch continuation and its total wire size.

`admissionMs` measures delegation/continuation until the provider reports
`response.created`; `modelMs` measures from that event, not from the preceding
request. `queueMs` includes waiting for the entire model function batch to
finish before execution. `toolMs` includes local execution and serialization.
Tools can overlap, so summed tool durations are not a non-overlapping wall-clock
breakdown. Missing provider token counts are `null`, not assumed zero. These
records do not measure microphone, ASR, audible playback or physical devices.
Direct shared text requests also log duration and usage under `core:voice-text`.

Keep the server log level at **info or more verbose**. Records appear in server
stdout/container logs. To retrieve them through `GET /api/server/logs` or
`clanky logs`, an administrator must enable the framework's existing capture
(`PUT /api/server/logs/settings` with `{"enabled":true}`). Clanky does not
automatically enable capture or bypass the configured log level. Timing logs
contain no prompts, transcripts, raw arguments/results or credentials.

#### Measured provider experiment before direct intents

On 2026-10-14, an isolated compiled Clanky app exercised four workflows using
the configured `gpt-6-luna`, actual catalog/tools and synthetic chats/tasks
backed by a normal external ACP process. Only the voice delegation was
simulated. Each workflow had one default-reasoning baseline and three
explicit-none runs; these small samples are diagnostic evidence, not a
performance guarantee or a controlled load benchmark.
Runs were sequential in the same app: message instructions changed one chat's
history, and provider queuing/cache effects were not controlled.

| Workflow | Default baseline | None median (range) | None model rounds |
|---|---:|---:|---:|
| Recent chats | 31.7 s | 27.9 s (11.3–45.6 s) | 7–10 |
| Named-chat conversation | 11.7 s | 15.8 s (13.5–16.7 s) | 7–9 |
| Send an instruction | 21.2 s | 15.2 s (14.4–27.7 s) | 8–13 |
| Chats/tasks requiring input | 40.9 s, incomplete | 14.2–31.4 s, incomplete | 9–18 |

The input-query runs found the waiting chat but omitted a task whose ready plan
required review. Another none run could not discover the operations and ended
after 4.0 s; it is a failure, not a fast answer, and is excluded from the table's
latency range. This exposes catalog-discovery reliability and incomplete
intervention metadata, not just latency. Message runs delivered separate
explicit instructions to an existing synthetic chat, verified through its
public conversation; they were not automatic retries.

Default responses reported `medium` effort and 40–1,113 reasoning tokens per
workflow. Every none response reported none and zero reasoning tokens.
Across 155 local tool completions, median execution/serialization time was
1.9 ms and maximum 28.8 ms. More than 99% of the measured end-to-end delegation
time was inside external text-request/stream intervals, including network and
provider queuing/generation, not just model computation. Generic discovery,
contract reads, extra state reads and their serial model decisions still
dominated with reasoning disabled. This baseline motivated the direct intents,
authoritative intervention metadata and bounded latest-history reads above.

A separate real `gpt-live-1` WebRTC smoke run accepted delegated none, reported
zero reasoning tokens and spoke "Checking that now" while fetching the chat
list. Its spoken-transcript event followed delegation creation by about 250 ms,
so the instruction is not a strict protocol ordering guarantee. That smoke run
used a continuous synthetic microphone; it does not measure physical-device
audio quality or replace the simulated-voice workflow timings above.

#### Measured direct-intent experiment

The same four workflows were repeated on 2026-10-14 with the final direct
schemas/instructions: three runs each, real `gpt-6-luna` Responses, compiled
Clanky, actual tool execution and isolated synthetic work. Only Live voice
delegation was simulated. All twelve final runs made **one direct function
call and two model responses**, with no find/describe or preliminary listing
for IDs. Reasoning was none, with zero reasoning tokens in every response.
Named-chat content and actual message admission were checked through public
conversation; intervention answers included both the pending question and
the manually reviewable task plan.

| Workflow | Median (range) | First response median | Final response median |
| --- | ---: | ---: | ---: |
| Recent chats | 6.15 s (5.33–6.38 s) | 3.23 s | 2.92 s |
| Named-chat conversation | 5.98 s (5.45–7.33 s) | 2.70 s | 2.88 s |
| Send an instruction | 5.67 s (5.48–6.24 s) | 2.76 s | 2.89 s |
| Chats/tasks requiring input | 5.80 s (5.71–6.22 s), complete | 2.76 s | 2.97 s |

First/final response columns measure the entire external request/stream
interval, not audible feedback or just computation; separate medians need
not sum to the median total. Local tool execution/serialization median was
9.7 ms, maximum 21.1 ms. More than 99% of each total remained inside the
external text intervals. An earlier 24-tool measurement serialized its schemas
to 26,455 UTF-8 bytes;
initial requests used 5,359–5,365 input tokens. The first recent-work request
was uncached; later sequential requests largely cached approximately 5,300
tokens. These small samples are not controlled cold-cache, load, p95 or
physical voice measurements. Repeated send runs were distinct explicit commands,
not automatic retries.

An initial direct-schema experiment occasionally listed before reading or
split the combined intervention query. The final instructions explicitly
prefer exact-name targets and one `waiting_work kind=all`; the final table
uses only the subsequent twelve runs. A separate native `gpt-live-1` admission
probe accepted the final schemas/instructions through a Bun.WebView-generated
WebRTC offer and real sideband validation (2.27 s), then closed the session.
That verifies connection compatibility, not ASR, spoken feedback timing,
physical playback quality or all tools' execution. No production settings or
existing user work were changed for these experiments.

### Native audio playback

Live uses the browser's native WebRTC adaptive buffering and media-element
playback. Clanky does not override the incoming receiver's jitter-buffer target,
add a PCM queue, or upload periodic browser audio statistics. Previously saved
voice settings still load; retired audio-buffer properties are ignored without
discarding provider credentials. The removed buffer experiment did not improve
the reported iPhone-speaker distortion; that physical-device issue remains a
separate investigation, not a claimed fix.

### Privacy, limits and recovery

Clanky creates the session and attaches its server-owned sideband using the
private configured key. It returns only the WebRTC SDP answer and an owned
Clanky call ID, not the provider key or a reusable provider token. Browser audio
travels **directly to the provider** over WebRTC; the server executes delegated
functions through authenticated sideband. The provider sees unmuted microphone
audio, delegated API data and the client's network connection. Audio and text
delegation can incur provider charges. Files, transcripts and tool results are
untrusted data, not instructions granting new authority.

Calls are ephemeral: Clanky does not persist recordings, voice transcripts or
call summaries, and does not create a hidden chat or enable provider recording
storage. For explicit restarts, the server keeps bounded recent user/assistant
text and operation references/outcomes in private per-user memory for ten
minutes after Stop. Older details can be omitted under the context limit; Live
rereads current work rather than treating remembered state as authoritative.
Transcript fragments can be incomplete and are not proof of voice approval or
heard audio. This memory expires automatically, is never saved in browser
storage or the database, and is cleared when Clanky restarts. Normal
created/instructed work is persisted by its own domain services. The server
also retains bounded in-memory correlation and terminal call state for cleanup
and diagnostics. Closing the call never writes into an arbitrary chat.

Provider failures include bounded event, code, type, parameter-path and
incomplete-reason identifiers in the existing server error log. Unsafe
metadata is redacted; raw provider error messages, frames, transcripts and
tool arguments are not logged. If Live connects but fails when using tools,
inspect these diagnostics rather than assuming a microphone or API-key issue.
An error is not evidence that an earlier mutation did not execute.

Continuation history is limited to 64 text messages and 7,000 UTF-8 bytes per
user. The server retains at most 64 recent user conversations; if that capacity
is reached, the oldest inactive context is discarded. These limits do not
remove ordinary chat/task data, which Live can read again.

There is one active call per user, a server capacity of eight calls and a
limit of ten session openings per minute per endpoint/key. Provider `429`
responses establish a cooldown and expose `Retry-After`; the browser does not
automatically retry. Start a new call after a connection failure, checking the
target first if an instruction's outcome is unclear. A 30-second browser lease,
renewed with heartbeats, closes abandoned calls without cancelling work.
Another tab cannot adopt the call or receive its UI commands. Reloading,
closing the tab or restarting Clanky does not automatically reconnect or turn
the microphone back on. Mobile OS suspension may interrupt media or expire the
lease; start a new call explicitly after returning.

### Public call endpoints

`GET /api/voice/live` returns `{ "supported": true }` without starting an agent.
`POST /api/voice/live` accepts `{ "sdp": "...", "clientId": "UUID", "context":
{ "revision": 0, "route": { "view": "home" } } }` and returns `201` with
`{ "call": { "id", "status", "error", "processing" }, "sdp": "..." }`.
The server attaches sideband before returning the SDP answer.

`GET /api/voice/live/:callId` reads owned call state. POST `heartbeat` accepts
`{ "clientId", "context" }`; POST `close` accepts `{ "clientId" }`.
POST `confirmations/:requestId` accepts `{ "clientId", "approved": true |
false }`, and POST `credentials/:requestId` accepts `{ "clientId",
"credentialToken": "UUID" | null }`. These suffixes are relative to
`/api/voice/live/:callId`. Approval and credential IDs are one-shot, expiring,
call-bound capabilities; they are not model tools.

All call routes require authentication and normal same-origin mutation policy.
Operations reuse the originating authorization, with an immutable role/scope
ceiling, and pass through the framework's authenticated request pipeline.
Provider session IDs are not accepted as authority. Old chat-local Live
endpoints are removed rather than aliased.

### Validation scope

The compiled-app global journey uses deterministic external Live and ACP
providers, real persistence/Git/SSH boundaries, originating-tab UI
acknowledgements and visual-approval/private-credential protocols. Native
Control journeys remain independent of Live. The protocol fixture is not proof
of WebRTC audio quality. Layout and media behavior are manually checked with
Bun.WebView; physical microphone/speaker quality, mobile OS suspension and
provider-specific connectivity require device/provider validation.

## Local Piper speech

Piper selects `es_AR-daniela-high` for Spanish and `en_US-ljspeech-medium` for
English. Language detection runs locally with a lightweight language detector;
short or ambiguous text falls back to Spanish. Markdown code and links are
excluded from detection when possible. No LLM request is made to select a
voice.

On the first spoken response, Clanky downloads the Piper runtime and the
selected voice model and configuration. The other voice is downloaded only
when first selected. Downloads use pinned upstream versions and SHA-256
verification, then are installed atomically under:

```text
$CLANKY_DATA_DIR/piper/
```

The Spanish voice model is about 114 MB, the English model about 64 MB, and
the runtime about 26 MB.

When `CLANKY_DATA_DIR` is unset, this is inside Clanky's default application
data directory. The selected runtime and voice remain there across restarts.
The first use needs outbound access to GitHub Releases and Hugging Face; later
speech synthesis uses the cached files.

Supported server targets are Linux x64/arm64, macOS x64/arm64, and Windows
x64. `/api/voice/settings` reports this platform support as `piper.available`;
it does not indicate whether the runtime or models have already been
downloaded.

## API behavior

`POST /api/voice/validate` accepts `{"capability":"transcription"}` or
`{"capability":"text"}` for those checks. Live validation requires
`{"capability":"live","sdp":"<browser-generated WebRTC offer>"}`. The Settings
UI creates that offer without microphone capture; the provider key remains on
the server.

`POST /api/chats/:id/messages/:messageId/speech` accepts no request body. The
server resolves the message in the authenticated user's chat and only generates
speech for existing assistant messages; missing, non-assistant, and
non-owned-chat messages are not found. If the assistant message is still
streaming, the server uses its current in-memory content. The configured text
model summarizes that content before Piper returns `audio/wav`.

The `/api/voice/transcribe` endpoint continues to use the configured
transcription provider.

`POST /api/voice/translate` accepts
`{"text":"<selected message text>","targetLanguage":"en"|"es"}` and returns
`{"translatedText":"<translation>"}`. It requires the user's validated shared
text-generation capability, accepts at most 30,000 characters, and does not
persist or associate the submitted text with a chat, task, or agent run.

## Upstream voice assets

- [Piper runtime release](https://github.com/rhasspy/piper/releases/tag/2023.11.14-2)
- [Argentinian Spanish voice files](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/es/es_AR/daniela/high)
- [US English voice files](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/ljspeech/medium)

The Spanish voice model card identifies its license as CC BY-SA 4.0. The
LJSpeech card states that its training dataset is public domain. Review the
upstream model cards and runtime notices for their full attribution and
redistribution terms.
