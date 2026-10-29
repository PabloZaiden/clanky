# Shared workspaces

Connect your local Clanky to another controller to work in selected shared
workspaces. Your instance remains a normal Clanky application, not an execution
worker. The controller keeps the conversations, tasks, agents, files and execution
resources; your instance stores the pairing, not a replica of that content.
Shared conversation and scratchpad drafts remain in browser memory rather than
local draft storage; reload discards unsent text.

## Invite and connect

Both instances must support workspace collaboration. Configure the workspace's
execution host and provider on the controller before sharing it. Choose one
connection route:

- **Direct** needs no relay. The controller's advertised HTTPS endpoint must be
  reachable from the invited instance or browser, with a trusted certificate
  and WebSocket forwarding for WSS. An internal-only or localhost address will
  not work for invitees on another network.
- **Relay** uses a [paired relay](mesh-worker.md) that supports workspace
  collaboration. The invitee must be able to reach its trusted HTTPS/WSS endpoint.

These are explicit routes, not automatic fallback choices.

On the controller, open **Settings > Collaboration > Invite collaborator**,
select **Direct** or **Relay**, the workspaces and each workspace's **Read only**
or **Work** access. For Relay, select the paired relay too. Creating an invitation
opens a download of a named `.clanky-invite.json` file. **Download invitation**
retries the download while the dialog is open; verify the file was saved before
closing it. Give the file to the invited person through a trusted channel.
Treat it as a secret: do not publish it in issues, logs or shell history.
The invitation is one-use and expires; revoking an unused invitation prevents
its acceptance. Remove unneeded file copies after pairing.

Pending invitations show their workspaces and expiration beneath the invitation
name, with **Revoke invitation** alongside those details.

To grant **Work** access everywhere, select **All workspaces**
instead of individual workspaces. This includes all your current and future
workspaces, even if none exist when the invitation is accepted. The collaborator
can use them, including scratchpad, chats, tasks and agents, but cannot create,
configure, archive or delete your workspaces. This also prevents changing
**Clanky Context**, the execution host or provider. Server, user, credential and
collaboration-invitation administration are not granted. Existing all-workspaces
invitations and grants follow this Work-only policy after upgrading the controller.

On the invited instance, open **Settings > Collaboration > Connect controller**
and choose the invitation file. Files are limited to 72 KiB; the client validates
the file format, invitation signature and expiration before acceptance. An
optional controller name helps distinguish workspaces with the same name.
Pairing belongs to the accepting local user; other users of that instance do not
inherit it.

If acceptance reports an uncertain outcome, use **Reconnect** on the pending
connection. This recovers its existing identity rather than reusing the
invitation to create a different pairing.

An invitee can also use the [browser-only static client](static-client.md#browser-only-collaboration)
without running a local Clanky server. It accepts the same invitation file and
uses the same client protocol/policy over the selected Direct or Relay route. Its
nonextractable identity is kept in site storage rather than a Bun controller's
encrypted database. Browser pairings and Bun-controller pairings are distinct;
they are not automatically copied or migrated between hosts.

## Work normally

Local and shared workspaces appear together in the usual web, API and CLI
collections. Their normal resource references determine where operations run.
There is no connection flag or separate remote mode. Preserve the reference
returned by the API when reading or modifying a shared resource; do not extract
or construct its underlying controller ID.

Collaborators with **Work** access can work with existing and new conversations, tasks/plans,
workspace agents, scratchpad, Git/files, transfers, terminals and previews.
Chats and tasks show their creator. They cannot delete or administer the
workspace, change its host/provider, manage controller credentials or invite
another collaborator.

### All-workspaces access

The collaborator sees all the inviting owner's workspaces automatically with
effective `access: "work"`. Workspace creation and settings remain owner-only,
including in API/CLI calls and the browser-only client.

The grant survives restarts and reconnects. It cannot be reduced or revoked
one workspace at a time: revoke the whole collaborator, then create a normal
invitation if selected-workspace access is needed.

For API/CLI use, create the invitation with
`{ "allWorkspacesAdmin": true, "transport": "direct" }`, or use
`"transport": "relay"` with `"relayName": "<paired-relay>"`; omit
`workspaceIds` and `workspacePermissions`. The existing all-workspaces field name
is retained in API/storage contracts, but grants Work access, never administration.
`GET /api/collaboration/access` reports the all-workspaces flag and effective
`capabilities`; no collaborator receives `admin`. Operate on the returned
workspace references as usual. A controller reference does not authorize
workspace creation or controller-wide connection tests/host discovery.

### Workspace control and execution credentials

Managed native and deterministic executions automatically receive scoped
application control for their own project. Supported native agents manage
project chats/tasks with their registered tools; deterministic code uses
`ctx.clanky.call()`. Neither requires **Allow general Clanky access** or a Quick
Chat preference. Existing `workspace.prompt()` remains bound to that
execution's conversation. Authority comes from the live execution source and
account, not an injected CLI/API key. An ended source cannot authorize further
control or pending approvals; this is not browser authority.

ACP model processes receive no automatic Clanky credentials, even when general
access is enabled; ordinary ACP chats/prompts remain supported. A deterministic
program retains its trusted runner control independently of its prompt adapter
and does not share that execution authority with ACP.

When the owner enables **Allow general Clanky access** (the existing Clanky
Context setting), the execution can additionally control in-scope resources
across the owner's permitted projects and registered servers. Collaborators
with Work access may use that enabled execution context; only the owner may
change the setting. Do not enable it for workspace code or participants you
do not trust with that broader application access.

Neither level grants account, API-key, session or collaborator administration,
or permits an agent to approve its own destructive work. General access remains
subject to current user authority and explicit human confirmation. Reducing
the grant constrains subsequent operations and pending approvals. See
[agent control and MCP](deployment.md#agent-control-and-mcp) for external
integration grants and human interactions.

Agents and their schedules stay on the owning controller. An invited controller
does not schedule a second copy. Work access permits manual runs and schedule
edits; admitted runs and schedules continue under the original owner.

### Read-only access

Permissions are assigned separately for each collaborator and workspace. A
collaborator can review one workspace while working in another. Existing grants
and invitations preserve their **Read only** or **Work** access after upgrading.

**Read only** allows reading conversations, tasks/plans, agents, transcripts,
logs, scratchpad, files and Git information, downloading files, and receiving
authorized realtime updates. The UI marks the workspace as read-only and
disables or removes modification controls. Controller credentials and other
participants' private interactive sessions remain subject to the existing
collaboration restrictions.

Saved subagent lists, snapshots, tool details and scoped realtime inherit the
parent conversation's workspace authority, including **Read only** access.
Child references are origin-qualified independently from their parent's ID;
native activity/message/tool identities are not rewritten. Bodyless read-aloud
requests resolve an authorized saved child assistant message and retain the
voice provider's availability/configuration requirements. None of these reads
permits sending to or stopping a child. Trash hides its saved children, and
revocation removes access to both history and future publications.

The controller also enforces these permissions for direct API/CLI calls and
the browser-only client. Changes return HTTP `403` with the
`collaboration_read_only` code. This includes sending messages, answering
questions or permission requests, starting/stopping work, changing schedules,
editing scratchpad/files, uploads, Git changes and arbitrary commands. Provider
execution, including task-title generation, also requires **Work** access.
Filesystem metadata reads remain available even though their API uses POST.
Interactive terminals, Code and application previews require **Work** access;
they cannot provide a read-only guarantee.

In **Settings > Collaboration > Collaborators**, change the access beside a
workspace with its compact **Read only** checkbox, without creating another
invitation. Unchecked grants retain **Work** access. Reducing access to **Read only**
closes that collaborator's existing terminals and previews in the workspace.
Realtime reconnects and refreshes the effective permissions. Already admitted
tasks, chats and schedules continue, and other workspace grants are unchanged.
Permission changes persist across restarts.
Unsaved Scratchpad edits remain in the open view when access changes, but
cannot be saved while read-only. Reloading still discards shared drafts.

API invitation requests may include
`workspacePermissions: { "<workspace-id>": "read" }` alongside `workspaceIds`;
selected workspaces omitted from that map receive `"work"`. To change an
existing grant, use
`PUT /api/collaboration/guests/:id/workspaces/:workspaceId` with
`{ "permission": "read" }` or `{ "permission": "work" }`.
Workspace responses expose the effective `access` for shared workspaces.

The browser-only client supports those workspace workflows except arbitrary
web/VS Code previews and inline streamed video. It has no local workspace or
execution-host creation, global controller administration, CLI listener or offline
execution. Images are bounded resources; downloads stage to browser disk and
require a separate export action under **Settings > Downloads**. See the
static-client guide for the 4 GiB target and browser/iPhone limitations.

For CLI automation, authenticate against **your own instance**, discover the
current schema, then use the workspace/resource reference returned by its API:

```bash
clanky api workspaces --method GET
clanky schema chats
clanky api chats --method POST --payload '{"workspaceId":"<returned-workspace-reference>","name":"Shared planning","model":{"providerID":"<provider>","modelID":"<model>","variant":""},"useWorktree":false}'
```

Preview and Code accept the shared workspace's exact name, just like a local
workspace. Keep your usual CLI profile connected to your invited instance:

```bash
clanky preview --workspace "Shared workspace" --port 3000
clanky code "Shared workspace"
clanky code "Shared workspace" --chat "Shared planning"
clanky code "Shared workspace" --task "Existing task"
```

HTTP and WebSocket traffic uses the invitation's Direct or Relay route. The
application port and Code process belong to the controller's selected workspace host; the printed
browser URL is on your CLI machine. Keep the command running while using it.
If workspace names collide across local or shared sources, select the exact
workspace reference returned by your instance instead. Chat/task names are
resolved only within the selected workspace; their qualified references also
work. Code requires a compatible `code serve-web` CLI on the workspace host;
see [Preview and Code](API.md#live-previews-from-the-cli) for prerequisites.

The controller's configured host performs the work, including when that host
is SSH or Mesh. Filesystem navigation is not restricted to the workspace's
initial directory: the execution account's permissions still apply.

Trash combines local and shared conversations with bounded pagination.
Individual restore/permanent-delete actions use the returned chat reference.
**Empty local Trash** only empties content owned by your instance; it does not
bulk-delete another controller's shared content. Restoration does not resume work.

## Connection state and recovery

The invited server maintains its transport/realtime connection without a browser
tab. Normal `/api/ws` and `clanky ws` interests include authorized shared
resources. Reconnection refreshes authoritative state; it does not replay
prompts, commands or uploads.

The browser-only client owns its connections while its document is active.
Reload recovers the saved identity; suspension/disconnection can interrupt
interactive work or transfers. A second document cannot take over the same
pairing while the first owns it. Foreground/reconnect refreshes authoritative
state instead of replaying prompts or terminal input. Already admitted
controller work does not depend on that document remaining open.

If a controller is unavailable, available local work remains usable and
collection responses carry `X-Clanky-Partial: true`. The web displays an
incomplete-results warning. CLI collection calls mark their JSON envelope on
stdout with `partial: true` and exit unsuccessfully; the HTTP collection body
keeps its normal shape. Name-based CLI selection rejects
incomplete or ambiguous collections; use an exact returned reference.

An individual unavailable remote resource fails explicitly, without falling
back to local content or an offline copy. Inspect **Settings > Collaboration**
or `GET /api/collaboration/connections` for per-origin health. Route transport,
controller realtime and collection-operation health are separate: a connected
relay alone does not prove that the controller is available.

## Retire access

On the controller, revoke one workspace or the whole collaborator from
**Settings > Collaboration**. Affected guest terminals and interactive previews
close, and new requests are denied. Other granted workspaces remain usable.
For all-workspaces access, revoke the whole collaborator.

Already admitted chats, tasks and agent schedules continue under the controller.
Revocation does not cancel them, delete shared content or undo commands.
Disconnecting a pairing on the invited instance also leaves controller work
intact. Neither action can retract information already seen or downloaded.

Direct pairing pins the controller identity. With Relay, the relay is a trusted
Mesh 7 hop: TLS protects each hop, but the relay can see the traffic, and pairing
pins both relay and controller. Neither route adds transitive trust, automatic
route fallback, offline work or an audit history; relay traffic is not
end-to-end encrypted between guests and controllers.
