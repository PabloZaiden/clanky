# Chat Trash

Deleting a standalone chat moves it to **Trash**, under the **Workspaces** tab
after Workspaces and Archived. Workspace chats and direct execution-server
chats are included. Tasks, task-owned conversations and agent-owned
conversations keep their existing deletion behavior.

## Recover and delete

- **Restore** returns the same chat with its history, original attachments,
  configuration and retained worktree/files. A chat deleted during active work restores stopped; continue it
  manually. Restoration never automatically resumes an agent or queued input.
- **Delete permanently** removes one trashed chat, its managed attachment
  copies and its managed worktree.
- **Empty Trash** permanently deletes the chats currently in your Trash,
  including hidden private chats. New deletions during an empty operation are
  not added to that operation.

Permanent deletion requires confirmation and cannot be undone. Shared repository
branches are not deleted merely because a chat used them.

Chats remain recoverable until permanently removed. They become eligible for
automatic removal after 30 elapsed days in Trash. Clanky checks at startup and
every 24 hours, processing bounded batches; expiry is not an exact-second
deadline. Restoring clears the retention clock, and deleting again starts a new
30-day period. Repeating Delete on an already trashed chat does not extend it.

## Workspaces, storage and unavailable hosts

Trash retains chat data, attachments and managed worktrees, so they continue using storage.
Trashed chats do not block workspace deletion. Deleting their workspace also
permanently deletes them, even if their 30 days have not elapsed.

Remote resource cleanup uses the original execution host. If external cleanup
fails during ordinary permanent deletion, the chat stays in Trash for retry.
Pending Continue from history exports are retained while a chat is in Trash;
their existing temporary-export expiration still applies.
Workspace deletion is not blocked by unavailable trashed-chat hosts; incomplete
external cleanup is logged and remote resources may need manual removal.

Trash is private to the current user and follows the normal private-item
visibility preference. Deleting a workspace or chat does not roll back unrelated
changes to shared repository files. Chats physically deleted before this feature
was installed cannot be recovered.

## HTTP and CLI

| Operation | Endpoint |
| --- | --- |
| Move a chat to Trash | `DELETE /api/chats/:id` |
| List Trash | `GET /api/trash` |
| Restore | `POST /api/trash/:id/restore` |
| Delete permanently | `DELETE /api/trash/:id` |
| Empty Trash | `DELETE /api/trash` |

These authenticated user routes enforce same-origin checks on browser mutations.
Use `clanky api` and `clanky schema` to discover the same operations from the CLI.

Trash listing returns `{ items, nextCursor }`. `limit` defaults to 30 and accepts
1-100; pass `cursor` from the previous page to continue. `includePrivate=false`
omits chats whose chat, workspace or registered execution server is private.
Each item includes `id`, `name`, `workspaceId`, `origin`, `isPrivate`,
`deletedAt`, `expiresAt` and `credentialServerIds`. The latter identifies owned
SSH servers whose credentials may be needed for resource cleanup; it contains
no credential values.

Permanent deletion and emptying accept an optional JSON body
`{ "credentialTokensByServerId": { "<server-id>": "<credential-token>" } }`.
Obtain each short-lived token through the normal SSH credential exchange.
The browser resolves stored credentials for all selected servers, including
hidden private chats when emptying; CLI/automation discovery declares the same
per-server credential mapping. Missing credentials leave affected entries in
Trash rather than deleting their records without cleanup.

Restore does not return or start a provider session. Use the normal chat endpoints
after restoration. Trashed chats are unavailable through ordinary chat reads,
transcript exports and mutations.

Emptying returns `{ success, deletedCount, failedCount, failures }`; inspect `failedCount` before
treating the operation as complete. Cleanup failures do not prevent other
selected chats from being processed. Details are bounded to the first 100
failures; the count includes every failure.
