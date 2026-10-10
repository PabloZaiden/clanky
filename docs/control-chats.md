# Control chats

A control chat is a normal workspace chat whose native Codex or Copilot agent
can operate Clanky on the signed-in user's behalf. It uses the user's configured
Quick Chat workspace; there is no separate conversation type or control-workspace
setting.

Sending, queueing, steering, questions, streaming and persistence use the same
services as other chats. Consecutive queued instructions from the same browser
tab are grouped into a turn; instructions from another tab and question replies
start separate turns. This rule does not depend on whether control tools are
enabled.

## Setup

1. Choose a workspace in **Quick Chat settings**.
2. Install and authenticate Codex or Copilot on that workspace's execution
   host. Native runtimes run on the selected host; local and Mesh v6 paths are
   supported. Direct SSH supports ACP only. See
   [Harness adapters](harnesses.md#workspace-configuration) for runtime setup.
3. Create a normal Codex or Copilot chat in that workspace and send an
   instruction there.

Clanky injects its managed API base URL and the user's API credential into
control-chat runtime environments. If the workspace, credential, native
provider, or advertised Mesh capability is unavailable, starting control tools
fails explicitly rather than starting a chat that appears able to control
Clanky but cannot.

## What the agent can do

The shared native tool set can:

- List workspaces and chats; inspect chat state, pending questions, activity,
  and transcript snapshots.
- Read workspace files through Clanky's file API and the selected workspace
  host; read or update workspace and Quick Chat settings.
- Create a chat, send a message to another chat, or answer a pending chat
  question.
- Read the in-memory server log snapshot when the user's API credential has
  admin access.
- Ask the browser tab that sent the current control-chat turn to open a
  workspace, workspace file, or chat.

For work on another repository, the control chat delegates by sending an
instruction to that repository's chat. It does not run Git commands directly
against another workspace. To read a file's contents, use the file-reading
tool; opening a file in the UI only displays it and does not send its contents
to the model.

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

All native Codex and Copilot chats can optionally use [Live voice](voice.md#live-voice).
GPT-Live carries the conversation and delegates interpretation to a Responses
model; that model directs the linked chat through bounded functions while the
native workspace agent retains its existing tools. Live can continue speaking
while the agent works. Closing the voice call does not interrupt agent work.

## Provider limitations

Only normal workspace chats using native Codex or Copilot receive these tools.
ACP and other providers do not receive them. Use the versions and execution
hosts supported by the [harness guide](harnesses.md).

Codex persists dynamic-tool definitions with the thread history and restores
them when `thread/resume` loads that history. The same control chat can
therefore continue after restarting Clanky or its host, provided Codex's home
and session data persist. As with other Codex chats, do not expect an in-flight
turn to continue if the worker is stopped while it is running. No separate
Codex daemon is required. Copilot registers its tools on session creation and
resume.

This feature controls Clanky through a normal chat; it does not add a standalone
command textbox, arbitrary DOM control, or direct repository execution against
another workspace by the control agent.
