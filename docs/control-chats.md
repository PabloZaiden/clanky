# Control chats

Native Codex, Copilot and OpenCode 2 executions can collaborate through Clanky's
shared application-control tools. Normal workspace chats and managed
Automation runs automatically receive workspace access. Neither Quick Chat setup
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
2. Create a native chat or Automation run in that workspace.

For OpenCode 2, select `agent.adapter: "opencode2"` and configure a model in
its isolated Clanky profile. Control eligibility for all three runtimes follows
the native adapter, not the model's provider name.
For external clients, scoped credentials, approvals and MCP setup, see
[Agent control and MCP](deployment.md#agent-control-and-mcp).

Clanky admits a scoped control connection from the execution's validated owner,
active chat or Automation run and workspace. It does not issue a CLI API key
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
see [deterministic execution](API.md#deterministic-automation-execution).

## What the agent can do

Native adapters discover their applicable definitions from the authenticated
common control owner. They do not maintain a separate native catalog or use
broad credentials to call arbitrary REST routes. Successful and pending results
are returned without a native-specific wrapper.
Actual chat roots supply their real chat ID during discovery so the server
can include optional browser tools after checking the execution source.
Scheduled-run roots omit it; this does not change Mesh bindings or
grant additional authority.

Workspace access permits reading literal chat history and creating,
messaging and managing work in that project, subject to the user's existing
permissions and human-approval policies. Explicit general access is required
for other workspaces and in-scope workspace/server administration. A workspace
agent cannot grant itself that authority.

For these workspace executions, general access includes all catalogued application
capabilities within the real user's permissions, including account/key/session
and integration administration, invitations, enrollment, settings and binary
transfers. Roles, ownership and human confirmation still apply. Agents cannot
approve requests or change the approval policy. Internal authentication,
execution leases and real-client acknowledgements are infrastructure, not
application operations. External integration grants and Live Voice retain
their existing exclusions; see the canonical
[access and discovery policy](deployment.md#agent-control-and-mcp).

Common direct tools need no discovery. For other intents, request
`clanky_list_operations` once to receive the complete compact authorized index,
then describe and execute the chosen operation. Its abbreviated descriptions
are an index, not input contracts. Do not repeatedly guess keywords or invent
API paths. The index adds no authority, and existing Codex threads still retain
their originally registered definitions as described below.

For binary or private operations, `clanky_describe_operation` declares required
file delivery and allowed request headers. `clanky_execute_operation` accepts
absolute paths on the originating execution's admitted host: `bodyFile` supplies
raw bytes or private JSON instead of `bodyJson`, `headersFile` supplies a JSON
record of declared header names/string values, and `responseFile` receives the
response. Private JSON input is limited to 1 MiB and header JSON to 40,000 bytes;
raw binary input remains streamed. The target workspace may be on another host.
Inputs are frozen before approval; editing their original files does not change approved work. Outputs
are privately staged beside their destination and published with mode `600`;
only path, byte count and content type return to the model. Existing destinations
require explicit `overwrite: true`. Never place credential contents inline.
Generated account setup links use the same resolved controller base URL as
approval links, not an internal dispatch origin.
Graceful rejection, cancellation, expiry and shutdown remove staging files.
Pending work is not restored after an abrupt termination; protected staging
directories may remain on the execution host after an unclean shutdown.

For work on another repository, an authorized agent delegates by sending an
instruction to that repository's chat. It does not run Git commands directly
against another workspace. To read a file's contents, use the file-reading
operation; opening a file in the UI only displays it and does not send its
contents to the model. Browser tools are available only when the server can
reliably associate the current turn with its originating tab.

An admitted message is not completed agent work. Required human approval is a
pending result, never implicit approval; unattended scheduled runs
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

## Inline visuals

Native chats can use `clanky_html_preview` to inspect a generated page and
`clanky_html_render` to publish it inline. No project server or open browser
tab is required. Preview requires Chrome or Chromium on the controller, not
on Mesh workers. The server Docker image includes Chromium and fonts; other
installations must install a compatible browser or set `CLANKY_HTML_BROWSER`
to its executable. Publication and viewing do not require a controller browser.
Existing Codex threads retain their original tool catalog; use a new thread
for newly added tools.

Supply either complete inline `html` or a `.html`/`.htm` `path` on the chat's
execution host. Relative image paths resolve beside that file, or against the
chat's working directory for inline HTML. Static image `src`/`srcset`, SVG
image references, and CSS `url()` references are embedded after image-format
validation, including SVG. Original chat attachments can be referenced as
`attachment:filename.png` when unambiguous, or by the exact
`attachment:<messageId>/<attachmentId>` references returned by preview.
Local non-image resources must be inlined or use external URLs.
External URLs remain external and are loaded directly by the browser;
Clanky does not download, proxy, or rewrite them. Preview uses an HTTPS fallback
base for protocol-relative resources; published visuals inherit the app's
scheme. An explicit external base URL takes precedence.

Images are limited to 10 MiB each, 64 distinct local references, and 25 MiB
of prepared HTML. Inline tool input is limited to 128,000 characters; use
a file for larger pages. Preview reports missing resources and returns a
bounded PNG, console messages, full content height, and screenshot clipping
information. Inspect phone and desktop widths before publishing.
Publication rejects unresolved local resources.

Published pages use the message-column width and a script/form-enabled
iframe without same-origin access or a Clanky tool bridge. Shared CSS theme
variables follow the app's light/dark theme; canvas and script-rendered colors
can redraw on the window's `clanky:theme-change` event. Use fluid layouts and
content-based height, not viewport-height sizing; larger pages have an
expansion control. Each publication is a separate persistent timeline entry.
The saved HTML and embedded images survive source-file removal and server
restart. Recoverable Trash retains them; permanent chat deletion removes them.
Ordinary history carries only the reference, with HTML loaded separately.
External resources still depend on their original hosts.

Preview executes page scripts on the controller's network. Its iframe sandbox
and temporary browser profile are not process or network isolation. Root-run
Chromium uses `--no-sandbox`; do not use previews for hostile HTML.

General notification and visual-use guidance is configured through each
harness's native session instruction channel, not appended to user messages.
It is restored on resume without adding synthetic conversation messages.
Native preset and project/user instructions remain in effect.

## Agent notifications

Set your webhook URL in **Settings → Agents & integrations →
Notifications**. The private URL is saved per user across workspaces and server
restarts. Reads disclose preferences and whether it is configured, never its URL; paste a new URL to
replace it or click **Clear** to remove it immediately and disable delivery.
Configure it from an API-backed controller client; invitation-only browser
clients do not expose controller credential settings.
Use HTTPS outside trusted local development. Clanky accepts HTTP(S) URLs without
URL user credentials or fragments, including private self-hosted Listen servers.
The webhook token remains on the controller, not in agent prompts, tools,
execution-host configuration, or logs.

**Payload** defaults to **Listen**, which sends Listen's native JSON automatically.
Existing webhooks need no changes. To use another service, select **Custom JSON**,
write a valid JSON template, and click **Save**. Changing the payload does not
require pasting the saved webhook URL again.

Use `{{title}}`, `{{shortDescription}}`, and `{{markdownContent}}` inside JSON
string values, including nested objects and arrays. For a service accepting
a `text` field:

```json
{
  "text": "{{title}}\n{{markdownContent}}"
}
```

Variables are substituted once and JSON-escaped, so quotes, backslashes, and
newlines in notification text remain valid JSON. Numeric literals retain their
original precision and notation. Keys are literal, and no code is evaluated.
Unknown variables and invalid JSON are rejected before saving.
Templates are limited to 64 KiB and rendered custom payloads to 1 MiB; an
oversized result is rejected without sending. Both explicitly requested and
opted-in automatic notifications use the saved payload. Templates persist
across restarts and must not contain credentials or other secrets.
Delivery remains a JSON POST; custom methods and headers are not supported.

Native Copilot, Codex and OpenCode 2 workspace chats and managed Automation runs
receive `clanky_send_notification` through the existing common control tools.
It requires no general-access grant or extra confirmation. Local and Mesh
executions share controller-owned delivery; standalone execution-host chats,
and native subagents do not receive this integration. Existing Codex threads
retain their previously registered tools: start a new conversation if the
notification tool is missing.

**Receive automatic notifications** is a per-user master checkbox. Separate
checkboxes select errors, questions, secret requests, permission
and approval requests, and finished chat responses.
The master and every event default to off. Turning the master off preserves
all event selections; turning it back on resumes that selection. Saving a
webhook does not enable either the master or any event. Preferences may be
selected before configuring a webhook, but delivery requires a saved webhook.
The sidebar bell immediately to the left of Live voice toggles the same master
preference and stays synchronized with Settings. A crossed-out bell means
automatic notifications are disabled; the toggle does not change the webhook
or event selections.

Enabling an event is explicit consent for Clanky itself to send that kind of
automatic notification when the master is on. Finished work means a standalone
chat's completed response/turn. Completed managed Automation runs do
not generate automatic notifications; an Automation can still send a notification
when explicitly requested by the user.
Interruptions, failures, pending questions and progress updates are not
completion. Automation-linked chats do not generate duplicate completion or
error alerts for their enclosing work. Managed Automation runs
retain their unattended input policy; this setting does not enable questions
or secret forms where those interactions are unavailable. Automatically
approved permissions do not require an approval alert; pending native
permissions and presented/pending agent-operation confirmations do, including Voice.
Transcript and progress updates do not resend alerts for existing pending
interactions.

Automatic messages identify the chat or managed Automation by name and include
the event description. Questions include a brief excerpt of the question;
secret requests include the credential's label and purpose, never its value or
internal identifier. Native permission alerts identify the work and request a
decision without copying provider permission text, which can contain tool-call
titles, commands or paths. Agent-operation approvals include the existing
human-facing action description. Text is trimmed and shortened to fit Listen's
title and description limits; the Markdown body includes up to 1,000 characters
of request context as escaped text.

Private work and work in private workspaces retain generic alerts without names
or request text; linked chats also inherit their Automation parent's privacy.
Private approval targets, including Automation runs and terminals, and file-backed
operations also retain generic alerts. Terminal target privacy includes its
workspace and execution host. Targets whose privacy cannot be resolved
retain generic alerts. Notifications never copy submitted answers, private secret
files, arbitrary transcript content, error diagnostics, tool arguments or webhook
credentials. Request labels, purposes and approval descriptions should explain
what is needed without embedding credentials, since that metadata is sent to
the receiving service. Delivery failures appear in this Settings section with
their timestamp and update live for that user. The last failure survives restart
until the webhook is replaced or cleared, or its payload is changed; outstanding
failures from the previous configuration cannot restore that cleared error.
Delivery does not depend on an agent tool, an open browser, or native provider support.
There is no replay of past events on startup or when preferences are enabled.

Agents are still instructed to send notifications **only when explicitly requested
by the user**. Neither saving a webhook nor enabling automatic event preferences
authorizes discretionary tool calls. The master checkbox controls automatic
event notifications only, not explicitly requested `clanky_send_notification` calls.
This is an agent instruction and tool-description policy, not an additional
application-enforced per-chat permission.

The tool accepts the same text fields in both payload modes: `title` (1–100 characters),
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
inspect the receiving service before repeating a send.

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
started from the sidebar rather than a chat. It can operate chats,
workspaces and servers through authorized API contracts and navigate its
originating tab. It requires neither a native adapter nor a Quick Chat workspace.
Native executions use the same common control operations while keeping their
turn-based browser provenance; they do not become global voice sessions. Ending
voice does not interrupt their agent work.

## Provider limitations

Control tools belong to the active owned root execution of a workspace chat
or managed Automation run. Automation runs retain their unattended question
policy; standalone execution-host chats and native subagents do not inherit
workspace control. Runtime versions, provider-specific tool registration and
resume requirements belong in the [harness guide](harnesses.md).

Clanky removes `CLANKY_BASE_URL` and `CLANKY_API_KEY` from provider environments,
including values inherited from the server or worker. Provider authentication,
personal API keys, interactive terminals and deterministic programs'
controller-owned control remain unchanged.

Every action still requires current server authorization, regardless of when
its provider tool definition was registered. Browser actions require the
originating chat/tab/turn provenance; unattended runs use execution-owned
authority without claiming a browser tab. This is not arbitrary DOM control
or direct repository execution in another workspace.
