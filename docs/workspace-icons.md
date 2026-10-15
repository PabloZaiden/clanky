# Workspace and provider icons

Workspace icons make repositories easier to recognize in the sidebar, Active
Work, and the dashboard. Provider icons are selected automatically from the
workspace's configured provider.

## Set a workspace icon

Open the workspace settings and use the **Workspace icon** section. You can:

- Choose **Search** to look for repository icons, then preview and select a
  candidate. Clanky does not search until you request it; choose **Search
  again** to refresh the candidates.
- Upload an SVG or ICO file from your computer, up to 1 MB.
- Remove the current icon and return to the default workspace mark.

For Git workspaces, Clanky searches within that workspace's Git repository on
its selected execution host; it does not scan the rest of the host. Discovery
includes tracked files and unignored untracked files named `*icon*.svg` or
`*logo*.svg`. It also offers
`*icon*.ico`, `*logo*.ico`, and `favicon*.ico` files. Up to 200 candidates are
shown. Repository discovery is not available for directory-only workspaces;
you can still upload an icon manually.

Selected icons are copied into private Clanky storage. The workspace does not
depend on the source file remaining in the repository, and later changes to
that file do not change the saved icon. Select it again to refresh the copy.
SVG uploads and candidates are sanitized before storage. The saved image is
available only to users authorized for that workspace.

## Provider icons

Provider icons follow the provider configured for the workspace, regardless
of whether it uses a native adapter or ACP. OpenCode, Codex, and GitHub Copilot
have distinct icons; other ACP providers use the generic ACP icon.

The workspace icon appears beside the workspace name. In Active Work, the
provider mark follows the item type, such as **Chat**, in the sidebar and
dashboard. Dashboard cards show the activity age on the left and the item
type/provider on the right of a full-width footer, independently of the
status label's width.
