# Workspace Scratchpad

Open a workspace's action menu and choose **Scratchpad** to write workspace-specific Markdown. Use **Code** and **Preview** to switch between editing the source and reading the rendered note.

Changes are kept in this browser until saved. **Save** stores changed content on the Clanky server for that workspace. **Reload** reads the saved server version; if local edits are pending, confirm before replacing them. Cancelling keeps the local draft.

Unsaved drafts are browser-local and are not available from another browser or device. Only saved content is stored with the workspace in Clanky's database.

Scratchpad content is limited to 100,000 characters. Workspace collection responses omit the `scratchpad` field to avoid returning note bodies; reading an individual workspace returns its full saved note.
