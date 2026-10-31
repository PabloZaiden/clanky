# Control chats

Native Codex, Copilot and OpenCode 2 executions can collaborate through Clanky's
shared application-control tools. Normal workspace chats, tasks and managed
Agent runs automatically receive workspace access. Neither Quick Chat setup
nor the workspace's general-access setting is required for project work.
There is no separate control conversation type.
Codex registers the new tools only on newly created native threads; resuming
an existing thread preserves its previously registered catalog.

Sending, queueing, steering, questions, streaming and persistence use the same
services as other chats. Consecutive queued instructions from the same browser
tab are grouped into a turn; instructions from another tab and question replies
start separate turns. This rule does not depend on whether control tools are
enabled.

## Setup

1. Install and authenticate Codex, Copilot or OpenCode 2 on the workspace's
   execution host. Native runtimes run on the selected host; local and Mesh v7 paths are
   supported. See
   [Harness adapters](harnesses.md#workspace-configuration) for runtime setup.
2. Create a native chat, task or Agent run in that workspace.

For OpenCode 2, select `agent.adapter: "opencode2"` and configure a model in
its isolated Clanky profile. Control eligibility for all three runtimes follows
the native adapter, not the model's provider name. Selecting Codex or Copilot
as an ACP provider does not enable Control.
For external clients, scoped credentials, approvals and MCP setup, see
[Agent control and MCP](deployment.md#agent-control-and-mcp).

Clanky admits a scoped control connection from the execution's validated owner,
active chat, task or Agent run and workspace. It does not issue a CLI API key
for these tools; caller-supplied workspace IDs are not grants.
If the source, account, native provider, or advertised Mesh capability
is unavailable, starting control tools
fails explicitly rather than starting a chat that appears able to control
Clanky but cannot. Local control invokes the common controller core directly;
Mesh control uses the admitted execution's existing event/RPC infrastructure
over direct TLS or relay. Its lease-level control channel is ready before the
provider connects, including OpenCode tool discovery. No independent return
endpoint, reachable controller public hostname, CLI executable or CLI
environment is required. Workspace and general grants change authorization,
not transport. Explicit human CLI/terminal use is unchanged. Deterministic
tools and current-conversation prompts use controller-owned authority too;
see [deterministic execution](API.md#deterministic-agent-execution).

## What the agent can do

Native adapters discover their applicable definitions from the authenticated
common control owner. They do not maintain a separate native catalog or use
broad credentials to call arbitrary REST routes. Successful and pending results
are returned without a native-specific wrapper.
Actual chat roots supply their real chat ID during discovery so the server
can include optional browser tools after checking the execution source.
Task and scheduled-run roots omit it; this does not change Mesh bindings or
grant additional authority.

Workspace access permits reading literal chat/task history and creating,
messaging and managing work in that project, subject to the user's existing
permissions and human-approval policies. Explicit general access is required
for other workspaces and in-scope workspace/server administration. A workspace
agent cannot grant itself that authority.

General access uses explicit route exclusions rather than an additional list of
permitted modules. It includes ordinary application and framework diagnostics
such as health/version, subject to the real user's roles and existing
confirmation policies. Private credentials, account/session administration,
self-approval and internal/binary protocols remain excluded; see the canonical
[access and discovery policy](deployment.md#agent-control-and-mcp).

Common direct tools need no discovery. For other intents, request
`clanky_list_operations` once to receive the complete compact authorized index,
then describe and execute the chosen operation. Its abbreviated descriptions
are an index, not input contracts. Do not repeatedly guess keywords or invent
API paths. The index adds no authority, and existing Codex threads still retain
their originally registered definitions as described below.

For work on another repository, an authorized agent delegates by sending an
instruction to that repository's chat. It does not run Git commands directly
against another workspace. To read a file's contents, use the file-reading
operation; opening a file in the UI only displays it and does not send its
contents to the model. Browser tools are available only when the server can
reliably associate the current turn with its originating tab.

An admitted message is not completed agent work. Required human approval is a
pending result, never implicit approval; unattended tasks and scheduled runs
do not wait indefinitely or auto-answer it. An interrupted or timed-out request
can have an uncertain outcome and must not be automatically replayed.
Humans can review requests in **Settings → Agents & integrations → Approvals**
or Home's **Needs attention**, not only the returned link. The same Settings
section contains the per-user **Require approval for agent operations**
checkbox, enabled by default. Disabling it executes new nonvoice confirm-class
operations directly within their existing grant; it leaves pending requests
unchanged. Agents cannot change this policy. Live Voice always confirms.
Native confirmations have a fixed one-hour deadline; each approval authorizes
only its own frozen action. For bulk automatic-workspace restarts, adding or
removing an eligible workspace, or changing its restart host binding while
approval is pending, invalidates the request. Read the current targets and
request a new confirmation before restarting.

## Agent notifications

Set a Listen source's webhook URL in **Settings → Agents & integrations →
Notifications**. The private URL is saved per user across workspaces and server
restarts. Reads disclose preferences and whether it is configured, never its URL; paste a new URL to
replace it or click **Clear** to remove it immediately and disable delivery.
Configure it from an API-backed controller client; invitation-only browser
clients do not expose controller credential settings.
Use HTTPS outside trusted local development. Clanky accepts HTTP(S) URLs without
URL user credentials or fragments, including private self-hosted Listen servers.
The webhook token remains on the controller, not in agent prompts, tools,
execution-host configuration, or logs.

Native Copilot, Codex and OpenCode 2 workspace chats, tasks and managed Agent runs
receive `clanky_send_notification` through the existing common control tools.
It requires no general-access grant or extra confirmation. Local and Mesh
executions share controller-owned delivery; ACP, standalone execution-host chats,
and native subagents do not receive this integration. Existing Codex threads
retain their previously registered tools: start a new conversation if the
notification tool is missing.

**Receive automatic notifications** is a per-user master checkbox. Separate
checkboxes select errors, blocked work, questions, secret requests, permission
and approval requests, plans ready for approval, and finished chats/tasks.
The master and every event default to off. Turning the master off preserves
all event selections; turning it back on resumes that selection. Saving a
webhook does not enable either the master or any event. Preferences may be
selected before configuring a webhook, but delivery requires a saved webhook.

Enabling an event is explicit consent for Clanky itself to send that kind of
automatic notification when the master is on. Finished work includes a chat's
completed response/turn, a completed task, and a completed managed Agent run.
Interruptions, failures, pending questions and progress updates are not
completion. Embedded task/Agent chats do not generate duplicate completion or
error alerts for their enclosing work. Automatically accepted plans do not
generate a plan-approval alert. Blocked work means the task reported
a blocker, not an ordinary user-requested stop. Tasks and managed Agent runs
retain their unattended input policy; this setting does not enable questions
or secret forms where those interactions are unavailable. Automatically
approved permissions do not require an approval alert; pending native
permissions and presented/pending agent-operation confirmations do, including Voice.
Transcript and progress updates do not resend alerts for existing pending
interactions.

Automatic messages contain only a fixed event description and the work kind,
not names, conversation content, question text, error details, secret labels,
tool arguments, or webhook credentials. Delivery failures appear in this
Settings section with their timestamp and update live for that user. The last
failure survives restart until the webhook is replaced or cleared; outstanding
failures from the previous webhook configuration cannot restore that cleared error.
Delivery does not depend on an agent tool, an open browser, or native provider support.
There is no replay of past events on startup or when preferences are enabled.

Agents are still instructed to send notifications **only when explicitly requested
by the user**. Neither saving a webhook nor enabling automatic event preferences
authorizes discretionary tool calls. The master checkbox controls automatic
event notifications only, not explicitly requested `clanky_send_notification` calls.
This is an agent instruction and tool-description policy, not an additional
application-enforced per-chat/task permission.

The tool accepts Listen's text fields `title` (1–100 characters),
`shortDescription` (1–500 characters), and `markdownContent` (nonempty, at most
800 KiB). The common control transport's 256 KiB whole-request JSON limit still
applies. Titles and descriptions are trimmed. Icons are not supported.
Clanky POSTs JSON directly to the configured webhook; the Listen CLI is not
required. Notifications must not contain credentials or other secrets.

An accepted result confirms only a successful HTTP response, not browser push
delivery or that the user read the notification. Missing configuration and
validation errors do not send a request. HTTP rejection is reported with its
status, without reflecting remote response bodies. Requests have a five-second
deadline, do not follow redirects, and are never automatically retried.
Network errors, timeouts and server errors can leave delivery uncertain:
inspect Listen before repeating a send.

Deterministic programs use the same tool through
`ctx.clanky.call("clanky_send_notification", { title, shortDescription, markdownContent })`.
Only include that call when the user's requested program behavior explicitly
includes notifications. Inspect its returned `ok` and `completion` before
reporting delivery.

## Browser actions and multiple tabs

Each browser tab has its own ephemeral client ID. A control action is delivered
only to the tab that originated the turn, even when the same user has the chat
open elsewhere. The AppShell keeps listening while navigating away from the
chat transcript. Actions expire without replay or redirection if the originating
tab does not respond.

Opening a workspace file succeeds only after the originating tab confirms that
the requested file is the active, loaded editor file. An unsaved edit in a
different file is preserved and reported as a failure; Clanky does not discard
local edits to complete a control action.

Queued instructions can be steered into an active native turn, just as in other
native chats. Steering preserves the domain tools. If the steered instruction
comes from another tab, or its tab is unknown, browser-action routing is removed
for the rest of that turn rather than attributing the action to the wrong tab.
Domain operations remain available, and a subsequent ordinary turn can establish
its own browser provenance.

## Live voice

[Live voice](voice.md#live-voice) is now an independent global assistant,
started from the sidebar rather than a chat. It can operate chats, tasks,
workspaces and servers through authorized API contracts and navigate its
originating tab. It requires neither a native adapter nor a Quick Chat workspace.
Native executions use the same common control operations while keeping their
turn-based browser provenance; they do not become global voice sessions. Ending
voice does not interrupt their agent work.

## Provider limitations

New native Codex threads and owned Copilot/OpenCode 2 conversations receive
these tools for workspace chats, tasks and managed Agent runs. Tasks and Agent
runs retain their unattended question policy. Standalone execution-host chats
and native subagents do not inherit them.
Use the versions and execution hosts supported by the
[harness guide](harnesses.md).

ACP executions receive no automatic Clanky control or CLI credentials, even
when general access is enabled. Clanky removes `CLANKY_BASE_URL` and
`CLANKY_API_KEY` from their provider environment, including values inherited
from the server or worker. Ordinary ACP model execution and
provider credentials remain available. This does not disable personal API
keys, interactive terminals or deterministic programs' controller-owned
control. An ACP prompt subprocess does not inherit that authority.

Codex registers the new control tools only when creating a new native thread.
Existing threads retain the catalog registered with their history; resuming
them does not retrofit or upgrade those definitions. Codex restores persisted
definitions when `thread/resume` loads that history. The same native conversation
can therefore continue after restarting Clanky or its host, provided Codex's home
and session data persist. As with other Codex chats, do not expect an in-flight
turn to continue if the worker is stopped while it is running. No separate
Codex daemon is required. Clanky preserves existing native history and does
not reject resume merely because its tool catalog changed. Every invoked action
remains server-authorized and must satisfy the current common contracts and
grants, even when its definition was registered earlier. Clanky does not rewrite
provider histories, replace conversations, keep a separate legacy tool
implementation, or add an MCP fallback to upgrade existing Codex threads.
Copilot registers current tools on creation and cold resume.

Control belongs to the admitted execution, not a CLI credential or callback.
Mesh signs the control capability into its native lease; requests, replies and
cancellation reuse that lease's authenticated infrastructure. Browser context carries real
chat/tab/turn provenance, while tasks and unattended runs need no browser context:
their controller-owned grant identifies the canonical execution server-side.
The native adapter privately
requires an active owned root turn before forwarding any tool call.

OpenCode 2 loads a managed native Promise plugin on the selected execution
host. It exposes the same shared tools directly, without an ACP or MCP server.
The plugin forwards calls through a private authenticated loopback bridge.
The application-control connection stays in Clanky; no application API key is
put in the provider environment or plugin files.
Existing process-scoped OpenCode configuration and plugins are preserved;
Clanky does not write Control settings into the workspace repository.
Tools are available only to the owned root session's active turn, not
to its native subagents or unrelated sessions.

OpenCode restores the plugin and granted tools when resuming a persisted
conversation after restart. Its isolated native profile and Clanky data must persist. An
in-flight turn does not continue after its runtime is stopped. Missing or failed
plugin activation is reported explicitly rather than falling back to a
tool-less Control chat. Pending Control requests are cancelled on interruption,
session deletion, disconnect or runtime failure, and temporary plugin files
are removed during connection cleanup.
After abrupt Clanky process termination, abandoned plugin directories are
removed on the next native connection; directories owned by a live Clanky
process are preserved.

This feature controls Clanky through managed native executions; it does not add
a standalone command textbox, arbitrary DOM control, or direct repository
execution against another workspace by the control agent.
