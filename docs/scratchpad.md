# Workspace Scratchpad

Open a workspace's action menu and choose **Scratchpad** to write workspace-specific Markdown. Use **Code** and **Preview** to switch between editing the source and reading the rendered note.

Changes are kept in this browser until saved. Select **Save**, or press **Cmd+S** while the editor is focused (**Ctrl+S** on Windows/Linux), to store changed content on the Clanky server for that workspace. **Reload** reads the saved server version; if local edits are pending, confirm before replacing them. Cancelling keeps the local draft.

Unsaved drafts are browser-local and are not available from another browser or device. Only saved content is stored with the workspace in Clanky's database.

Scratchpad content is limited to 100,000 characters. Workspace collection responses omit the `scratchpad` field to avoid returning note bodies; reading an individual workspace returns its full saved note.

## Use the CLI

The CLI has no dedicated Scratchpad subcommand; use the authenticated `clanky api` command. List workspaces to find an ID, then read the saved note from that individual workspace:

```bash
clanky api workspaces --method GET
clanky api workspaces/ws-abc123 --method GET
```

Update the saved note by sending the complete Markdown content in the `scratchpad` field:

```bash
clanky api workspaces/ws-abc123 --method PUT \
  --payload '{"scratchpad":"# Project notes\n\nRemember to update the deployment guide."}'
```

Each `PUT` replaces the saved Scratchpad content; it does not append or merge text. To preserve existing notes, read the workspace first and submit the complete updated content. Set `scratchpad` to an empty string to clear the note. The same 100,000-character limit applies. The CLI reads and writes only the saved server copy, not an unsaved draft in a browser.
