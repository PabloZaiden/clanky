# Shared workspaces through a relay

Connect your local Clanky to another controller to work in selected shared
workspaces. Your instance remains a normal Clanky application, not an execution
worker. The controller keeps the conversations, tasks, agents, files and execution
resources; your instance stores the pairing, not a replica of that content.
Shared conversation and scratchpad drafts remain in browser memory rather than
local draft storage; reload discards unsent text.

## Invite and connect

Both instances and the relay must support workspace collaboration. First
[pair the controller with a relay](mesh-worker.md). Configure the workspace's
execution host and provider on that controller before sharing it.

On the controller, open **Settings > Collaboration > Invite collaborator**,
select the workspaces and paired relay, and create an invitation. Give its
one-use token to the invited person through a trusted channel. The token expires;
revoking an unused invitation prevents its acceptance. Do not publish tokens in
issues, logs or shell history.

On the invited instance, open **Settings > Collaboration > Connect controller**
and paste the token. An optional controller name helps distinguish workspaces
with the same name. Pairing belongs to the accepting local user; other users of
that instance do not inherit it.

If acceptance reports an uncertain outcome, use **Reconnect** on the pending
connection. This recovers its existing identity rather than reusing the
invitation to create a different pairing.

## Work normally

Local and shared workspaces appear together in the usual web, API and CLI
collections. Their normal resource references determine where operations run.
There is no connection flag or separate remote mode. Preserve the reference
returned by the API when reading or modifying a shared resource; do not extract
or construct its underlying controller ID.

Collaborators can work with existing and new conversations, tasks/plans,
workspace agents, scratchpad, Git/files, transfers, terminals and previews.
Chats and tasks show their creator. They cannot delete or administer the
workspace, change its host/provider, manage controller credentials or invite
another collaborator.

For CLI automation, authenticate against **your own instance**, discover the
current schema, then use the workspace/resource reference returned by its API:

```bash
clanky api workspaces --method GET
clanky schema chats
clanky api chats --method POST --payload '{"workspaceId":"<returned-workspace-reference>","name":"Shared planning","model":{"providerID":"<provider>","modelID":"<model>","variant":""},"useWorktree":false}'
```

The controller's configured host performs the work, including when that host
is SSH or Mesh. Filesystem navigation is not restricted to the workspace's
initial directory: the execution account's permissions still apply.

Trash combines local and shared conversations with bounded pagination.
Individual restore/permanent-delete actions use the returned chat reference.
**Empty local Trash** only empties content owned by your instance; it does not
bulk-delete another controller's shared content. Restoration does not resume work.

## Connection state and recovery

The invited server maintains its relay/realtime connection without a browser
tab. Normal `/api/ws` and `clanky ws` interests include authorized shared
resources. Reconnection refreshes authoritative state; it does not replay
prompts, commands or uploads.

If a controller is unavailable, available local work remains usable and
collection responses carry `X-Clanky-Partial: true`. The web displays an
incomplete-results warning. CLI collection calls mark their JSON envelope on
stdout with `partial: true` and exit unsuccessfully; the HTTP collection body
keeps its normal shape. Name-based CLI selection rejects
incomplete or ambiguous collections; use an exact returned reference.

An individual unavailable remote resource fails explicitly, without falling
back to local content or an offline copy. Inspect **Settings > Collaboration**
or `GET /api/collaboration/connections` for per-origin health. Relay transport,
controller realtime and collection-operation health are separate: a connected
relay alone does not prove that the controller is available.

## Retire access

On the controller, revoke one workspace or the whole collaborator from
**Settings > Collaboration**. Affected guest terminals and interactive previews
close, and new requests are denied. Other granted workspaces remain usable.

Already admitted chats, tasks and agent schedules continue under the controller.
Revocation does not cancel them, delete shared content or undo commands.
Disconnecting a pairing on the invited instance also leaves controller work
intact. Neither action can retract information already seen or downloaded.

The relay is a trusted Mesh 7 hop: TLS protects each hop, but the relay can see
the traffic. Pairing pins the relay and controller; it does not add transitive
trust, a direct-connection fallback, end-to-end encryption, offline work or an
audit history.
