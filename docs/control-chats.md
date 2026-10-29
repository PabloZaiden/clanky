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
   supported. Direct SSH supports ACP only. See
   [Harness adapters](harnesses.md#workspace-configuration) for runtime setup.
2. Create a native chat, task or Agent run in that workspace.

For OpenCode 2, select `agent.adapter: "opencode2"` and configure a model in
its isolated Clanky profile. Control eligibility for all three runtimes follows
the native adapter, not the model's provider name. Selecting Codex or Copilot
as an ACP provider does not enable Control.
For external clients, scoped credentials, approvals and MCP setup, see
[Agent control and MCP](deployment.md#agent-control-and-mcp).

Clanky supplies an execution-owned control connection with a scoped managed
credential, separately from CLI environment variables. The credential identifies
the admitted chat, task or Agent run and its workspace; caller-supplied workspace
IDs are not grants.
If the workspace, credential, native provider, or advertised Mesh capability
is unavailable, starting control tools
fails explicitly rather than starting a chat that appears able to control
Clanky but cannot. Local control invokes the common controller core directly;
Mesh control uses the worker's enrolled controller route, including the relay.
The worker does not need to resolve or reach the controller's public hostname
for control tools. Workspace and general grants change authorization, not
transport. This does not change `CLANKY_BASE_URL` for explicitly invoked CLI
commands, terminal environments, or the separate `ctx.workspace.prompt` callback.

## What the agent can do

Native adapters discover their applicable definitions from the authenticated
common control owner. They do not maintain a separate native catalog or use
broad credentials to call arbitrary REST routes. Successful and pending results
are returned without a native-specific wrapper.
Actual chat roots supply their real chat ID during discovery so the server
can include optional browser tools after checking the credential association.
Task and scheduled-run roots omit it; this does not change Mesh bindings or
grant additional authority.

Workspace access permits reading literal chat/task history and creating,
messaging and managing work in that project, subject to the user's existing
permissions and human-approval policies. Explicit general access is required
for other workspaces and in-scope workspace/server administration. A workspace
agent cannot grant itself that authority.

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
only its own frozen action.

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
from the server, worker or SSH login shell. Ordinary ACP model execution and
provider credentials remain available. This does not disable personal API
keys, interactive terminals or deterministic programs' trusted runner control;
an ACP prompt subprocess does not inherit that runner's credential.

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

Control has its own execution-bound transport, separate from the CLI
environment. Mesh admission binds its credential to the native lease; callbacks
use the registered direct or relay route. Browser chat context carries real
chat/tab/turn provenance, while tasks and unattended runs need no browser context:
their managed credential
identifies the canonical execution server-side. The native adapter privately
requires an active owned root turn before forwarding any tool call.

OpenCode 2 loads a managed native Promise plugin on the selected execution
host. It exposes the same shared tools directly, without an ACP or MCP server.
The plugin forwards calls through a private authenticated loopback bridge;
The control credential stays in Clanky's session-owned connection, not the
provider environment or plugin files.
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
