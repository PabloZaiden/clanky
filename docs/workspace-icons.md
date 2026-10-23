# Workspace and provider icons

Workspace icons make repositories easier to recognize in the sidebar, Active
Work, and the dashboard. Provider icons are selected automatically from the
workspace's configured provider.

## Set a workspace icon

Open the workspace settings and use the **Icon** row in **General**. You can:

- Choose **Search** to look for repository icons, then preview and select a
  candidate. Clanky does not search until you request it; choose **Search
  again** to refresh the candidates.
- Upload an SVG or ICO file from your computer, up to 1 MB.
- Remove the current icon and return to the default workspace mark.

Choosing a file, selecting a repository candidate, or confirming removal
previews the change and enables the workspace settings **Save** action.
Choose **Save** to apply it with your other settings, or **Undo** beside the
icon to restore the saved icon. Leaving with pending changes asks whether to
discard them. If saving the icon fails, the selection stays pending so you can
retry; any other settings already saved remain applied.

For Git workspaces, Clanky searches within that workspace's Git repository on
its selected execution host; it does not scan the rest of the host. Discovery
includes tracked files and unignored untracked files named `*icon*.svg` or
`*logo*.svg`. It also offers
`*icon*.ico`, `*logo*.ico`, and `favicon*.ico` files. Up to 200 candidates are
shown. Repository discovery is not available for directory-only workspaces;
you can still upload an icon manually.

Selecting a repository candidate captures its sanitized contents for the
preview and pending change. Saving keeps that same image even if you also
change the execution host or the source file changes before you save.
Icon-only saves do not require an available execution host for uploads or
removal.

Saved icons are copied into private Clanky storage. The workspace does not
depend on the source file remaining in the repository, and later changes to
that file do not change the saved icon. Select it again to refresh the copy.
SVG uploads and candidates are sanitized before storage. The saved image is
available only to users authorized for that workspace.

Clanky discards SVG metadata and Inkscape named-view settings while
preserving the drawing. Simple inline presentation styles,
including fill and stroke colors, opacity, and stroke widths, are converted
to sanitized SVG attributes. Inline styles take precedence over presentation
attributes, including declaration order and `!important`. Other style
properties are discarded.

SVG icons must remain static and self-contained. Scripts, embedded HTML,
stylesheets, document types, and external references are not supported.
Gradient and other image references must point to IDs inside the same SVG.
Supported inline style values include colors, numeric values with units,
keywords, and local `url(#id)` references; CSS variables, escapes, and other
complex CSS expressions are not supported.

## Provider icons

Provider icons follow the provider configured for the workspace, regardless
of whether it uses a native adapter or ACP. OpenCode, Codex, and GitHub Copilot
have distinct icons; other ACP providers use the generic ACP icon.

The workspace icon appears beside the workspace name. In Active Work, the
provider mark follows the item type, such as **Chat**, in the sidebar and
dashboard. Dashboard cards show the activity age on the left and the item
type/provider on the right of a full-width footer, independently of the
status label's width.
