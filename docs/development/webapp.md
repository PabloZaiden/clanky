# UI and webapp development

Clanky uses `@pablozaiden/webapp` for the shared application foundations.
This guide records Clanky-specific integration and design decisions; consult
the [webapp skill](../../.agents/skills/webapp/SKILL.md) for framework APIs
and disposable browser tooling.
Clanky's Swift/WKWebView wrappers and their app-specific constraints are
documented in the [Apple app guide](../apple-apps.md), not the framework skill.

## Framework ownership

Use public framework primitives for shell/sidebar, routing, settings layout,
realtime, origin protections, assets, health, and server lifecycle. Do not
recreate them in Clanky or add app-local CSS/DOM workarounds for generic
framework behavior.

Keep the [fixed-scale viewport policy](https://github.com/PabloZaiden/webapp/blob/main/docs/server.md#composition)
in Webapp for integrated/static clients and PWAs, not in Clanky touch handlers.

Clanky owns account identity and roles, permissions, credential persistence,
API keys, device sessions, OAuth, account/administration screens, CLI, and
remote-client authorization. Connect those services to the framework's explicit
request, transport, session, and preference interfaces. Passkey verification
uses the optional framework ceremony helpers. Clanky retains its existing signed
browser-session protocol to preserve active sessions; password support is not
enabled. Do not add Clanky policies or storage to webapp.

All persistence is selected explicitly, including browser preferences.
Clanky's adapters preserve its existing database and credential/preference
namespaces. A framework composition without an adapter remains memory-only.

Use `WebAppRoute` as the canonical client route model and framework navigation
helpers. Do not add app-owned route unions, hash parsers/serializers, conversion
layers, or direct hash mutation. Replace undocumented legacy routing rather
than retaining a translation/redirect layer.

Never query, portal into, observe, or mutate framework-owned shell nodes to
implement titles/actions or infer theme. Use route-backed sidebar data and
documented header APIs; use public `useTheme()` for JavaScript theme state and
CSS variants when JavaScript is unnecessary. Dark is the no-preference default,
not an override of saved Light/System choices.

Use Clanky's shared account/configuration and effective log-level state.
Configure the framework through that integration; do not fetch parallel copies
of account configuration or maintain a second preference state.
Application state uses [framework realtime](architecture.md#application-realtime),
not app-owned raw WebSocket subscriptions.

## Layout and actions

The framework uses the desktop shell above 800 CSS pixels and the mobile drawer
at 800px and below. Compact wide displays can keep the sidebar and content usable
together without changing sidebar width or safe-area clearance for system bars.
Follow the framework mobile mode instead of adding a device-specific threshold
or shell CSS override.

The code explorer places its file tree beside the editor from 768 CSS pixels,
so an unfolded Duo in landscape can use both panels with the app sidebar
collapsed. Narrower views keep the stacked layout.

Settings category navigation follows the width available after the sidebar and
safe areas: at 800 CSS pixels or less it uses the Category dropdown; wider layouts
keep the category list. This applies to global and workspace settings without
changing the shell breakpoint or losing the selected category or mounted draft.

Route views use `Page` as their top-level wrapper. Prefer framework panels,
lists, form groups/actions, danger zones, loading/error states, and code values
before custom CSS. Do not recreate main-content spacing or repeat the fixed
title as an app-local heading; `EntityHeader` is for distinct entity headings.

Declare entity actions through route-backed `SidebarNode.actions`. Framework
sidebar context menus and the active title-bar menu share those actions.
Framework Pin/Unpin actions remain available in both menus, including when
explicit `contextActions` customize the sidebar menu.
Do not add Clanky shell/header menus or hide a single fitting action behind
ellipsis. Use framework dialogs and menus; they own Enter/Escape behavior,
red/last destructive items, and compact status-dot sidebar badges.

Chat sidebar entries also expose **Mark as Done** and **Delete** through
framework `swipeActions`. Drag left to reveal the actions without selecting the
chat or closing the mobile drawer. Active, workspace, execution-host, and pinned
entries use the same target-aware lifecycle actions as the chat menu. Mark as
Done remains unavailable for busy/reconnecting or nonstandalone chats and is
absent after completion. Delete keeps the existing confirmation and Trash
behavior; deleting another chat does not leave the current conversation.
Obscured private entries and read-only workspaces expose no lifecycle swipe
actions. Keep gesture mechanics in Webapp, not Clanky renderers or CSS.

Declare primary header actions through semantic `HeaderPrimaryAction`
descriptors. The framework moves them first into overflow on narrow screens
while preserving native form validation/submission. Do not duplicate or clip
actions or crowd titles.

The workspace overview promotes **New Chat** to a primary header action when
space permits, with framework-managed overflow otherwise. Its sidebar context
menu retains the same action; workspace subpages keep their existing menu.

Workspace menus group creation actions as **New Task** (Git workspaces only),
**New Terminal**, **New Chat**, and **New Agent**. **Import Agent** belongs to
the New Agent page and imports into its selected workspace. File-opening
actions use the label **Code Explorer**. Scratchpad opens from its overview
heading, not the workspace menu. Git-backed workspace overviews expose
**Pull Latest Changes** and **Open in GitHub** as page buttons; pulling retains
its busy state and requires work access.

In the sidebar's **Workspaces** tab, each workspace directly lists chats,
Git-backed tasks, and terminals together, including completed chats and
historical tasks. **Agents** is a peer section containing agents from all
workspaces, with their workspace names and inherited privacy/access rules.
In **Servers**, each server directly lists its workspaces, host chats, and host
terminals together. Mixed lists sort by most recent interaction (chat/task user
message or terminal connection, falling back to creation); server workspace
entries use the workspace's last update. Chats, tasks, and terminals reuse
Active's rich rows: workspace/host and textual status above the title, with
relative interaction time and type/provider metadata below. Agents and
workspace/server rows retain their own presentation.
There are no type or History subsections and no subsection-level New buttons.
Dashboard creation controls and entity context/header actions remain unchanged.

Ordinary actions, including primary actions, are unboxed icons/clickable labels.
Use public subtle/link/primary variants intentionally; reserve solid danger
for irreversible confirmation. Update/restart is not deletion.

Settings use structured `settings.sections[].rows` with explicit user/admin/owner
scope. Selectors/toggles go in `content`, operations in `actions`, and destructive
operations in danger presentation with framework confirmation. Custom `render`
is an escape hatch only when the row model cannot represent the setting; add
a nearby comment explaining the limitation.

Account, logging, passkey, session, API-key, user, and server settings are
Clanky-owned compositions. Keep their policy and data loading out of webapp.
Use the public theme state, Settings layout and fields; do not restyle native
selects or duplicate generic layout behavior.
User-access resets require a destructive confirmation naming the account and
its passkey, API-key and session revocation consequences.

Settings have two zones with controls/actions vertically centered and
right-aligned. Keep short fields compact, related fields together, and ordinary
validation/status inline. Dialog actions stay in one right-aligned wrapping
row, not reversed or left-aligned mobile columns.

For an individual setting, put the input in `content` and its buttons in
`actions`; do not place a field-plus-action-footer form inside `content`.
When they share a native form, wrap `SettingsFieldRow` in that form so the
framework aligns the input with the setting label rather than a stacked block.
Let the framework wrap controls below the label when the row has insufficient
space; do not force inline controls at the expense of readable labels.
Use the actual available row width, including the space consumed by the sidebar,
category navigation and safe areas. Short labels must not reserve a wide fixed
column. When even the control group cannot fit, fields and actions wrap within
the panel, retaining action order and right alignment; nested forms must shrink
with the panel rather than overflow it. This behavior belongs in webapp defaults,
not Clanky overrides or a device-specific breakpoint.

## Product presentation

Operational screens show labels, values, actions, status, errors, and actionable
warnings, not paragraphs about mechanics/navigation/persistence. Add helper
text only for valid/safe input or irreversible consequences.
Do not use setting subtitles or hints as feature documentation. Behavior,
authorization and storage explanations belong in the relevant guides, not
repeated underneath controls. Keep useful input constraints and counters.

Do not show internal IDs as names or default detail fields. Use workspace/host
names rather than directory paths as identity. Preserve IDs in protocols,
storage, APIs, user messages, code, and raw logs; this is a presentation rule,
not data rewriting.

Transcripts use 18px body text and 16px technical output on desktop and mobile.
Check rendered Markdown, raw text, code, and tool descendants, not just inherited
container styles. Across chat, task-log, and agent transcripts, visible
timestamps for entries before the current local day include the date and time;
same-day entries remain time-only. Keep the existing timestamp visibility
cadence, and refresh the displayed day at local midnight and when returning to
the foreground. Job lists/progress use compact title/date/status composition;
console output combines streams without extra stream-name prefixes.

Work-item lists and sidebar Active work share a composition: workspace/host
name and status, then item name, then relative interaction time and type/provider.
Keep framework controls and compact descriptions rather than screen-specific
spacing corrections.

Activity opens through framework entity actions while preserving conversation
DOM, scroll, and composer draft. An embedded task chat's **Chat activity** action
is distinct from execution **Activity**; tool rows link to their own scope.
Saved subagent selection stays inside that Activity composition. Reuse the
normal shared chat transcript presentation and read actions without mounting
the composer, editable chat lifecycle or input-voice gesture. Keep both parent
and Activity list mounted during child navigation. Child element IDs and audio
ownership must not collide with the hidden parent; use the parent's matching
execution-host/file context, not controller-local path guesses.
Steer is a text-style action below queued input. Admission, native delivery,
and model obedience remain separate concepts.

Chat and task composers place the conversation-options control between the
message textbox and the send/queue/interrupt button. Its sliders icon
distinguishes conversation controls and information from sidebar navigation;
the options panel opens above it, aligned to the right.

Transcript images load when their entries enter the visible conversation;
non-image files load only when downloaded. Keep attachment bytes out of
snapshot/history/live-message projections and defer
tool-preview detail reads until visible. Reuse authenticated resource helpers,
retain loaded unchanged images across transcript updates, and preserve the
existing click-to-enlarge interaction. Originals and provider uploads remain
unchanged; see [Conversation attachments](../attachments.md).

## Forms, effects, and feedback

Use public unsaved-change handling for composite settings drafts. Save failure
retains the draft, Cancel resets it, and simple autosave preferences show local
saving/saved/error status. Voice saves its settings together and validates each
saved capability separately.

Workspace Settings keeps one draft across General, Execution, and Maintenance.
Workspace archiving and privacy are controlled only by the **Archived** and
**Private** fields in General and are persisted with the same explicit Save.
Metadata-only saves remain available when the configured execution runtime is
unavailable. Validate execution only when its draft changes, and omit unchanged
runtime fields from metadata updates.
Save stays on the page; navigation uses the framework unsaved-change dialog.
Native validation opens the invalid field's category before focus. Independent
icon actions must not reset unrelated edits; keep the draft locked through
persistence, refresh, and saved-state update. Preserve deletion restrictions
and managed-directory confirmation. Use framework checkbox layout on mobile.

Global Settings remembers its category per app/client server; explicit links
win and unavailable categories fall back to General.

Control authorization uses Clanky's `control-request` and `control-consent`
routes. Request pages show the frozen action, expiry and canonical result;
approval uses a separate confirmation.
**Settings → Agents & integrations → Approvals** places the per-user approval
checkbox beside the pending collection. Use a structured settings checkbox row
and render the collection below it. The control-request route without a request
ID redirects to that Settings category; individual detail links remain valid
and their All approvals link returns there. There is no separate sidebar action
or standalone inbox. Pending requests also appear in Home's Needs attention;
both surfaces use the same user-scoped collection and realtime updates,
with local expiry removal during a connection interruption.
Subscribe to pending-collection changes, not generic workspace/chat/task/host
activity or policy/result updates. Read initially and after a relevant WS
notification or reconnect; keep the loaded empty/nonempty state visible during
background refresh rather than hiding it or showing initial loading again.
Approval summaries carry effective target privacy and use the shared private-row
reveal behavior, including inherited workspace/host privacy. The collection is
loaded for authenticated controller account clients, independent of API-key or
passkey session provenance. Use Clanky's current user and client
capabilities for availability, not passkey configuration or authentication
flags. See [authentication-method equivalence](architecture.md#authentication-method-equivalence).
Clients without controller capabilities see an unavailable Settings collection
instead of an approval-load error on Home.
OAuth consent reads its opaque request handle from the URL search
query, not route fields, and requires an explicit workspace/general selection.
Never pass that query through request-path logging. Scoped service credentials
live under Settings → Agents & integrations; newly issued tokens are shown
once and are not retained after the dialog closes. Authorized OAuth integrations
are listed there separately, with their selected access, scope and expiry.
Human revocation uses Clanky's grant-management API; no OAuth credentials
are displayed or copied into Clanky settings.
Listing and revoking owned integrations also works with a full-scope native
device session or API key; it does not require a separate browser cookie.

Separate lifecycle/realtime state, transcript/display state, and composer/form
state in large interactive views. Effects must be abortable, guard stale reads,
and keep failures visible. Keep loaded data visible during refresh rather than
flashing initial-loading states. Use shared request/action helpers instead of
duplicating request/error handling.

Transient feedback uses framework notifications, not an app-owned toast
provider or wrapper. Persistent failures stay in inline `ErrorState`/validation;
do not report one failure twice. Effects depend on stable notification methods,
not the reactive notification-list service object.

## Upstream framework changes

Missing generic UI behavior belongs in webapp defaults/public compositions,
not an app workaround. Never add dependency patches, `patchedDependencies`,
or manual edits to installed packages.

Accumulate related upstream work on one dedicated pushed branch for one PR.
Consume first-party packages directly from GitHub commits or release
tags, never npm publication. Prefer explicit SHAs and update `package.json` and
`bun.lock` together. Validate Clanky against each consumed revision; intermediate
stable releases are unnecessary.

During development, pin the exact immutable commit from the upstream PR, not a
feature-branch ref. Clanky may be ready and reviewed against that commit while
the upstream PR remains open, with its review complete and all feedback
addressed. The development pin does not need to be reachable from webapp `main`.

Do not merge the upstream PR or enable its auto-merge until the user explicitly
requests merging Clanky. Approval to implement, open a PR, or prepare it for
merge is not that request; completed reviews and green checks are not merge
authorization either.

When the user requests merging Clanky, complete this sequence:

1. Follow the [PR review and merge rules](../development.md#pull-request-reviews)
   and finish merging the upstream PR into webapp `main`, if still needed.
   Wait for the actual merge; queued auto-merge is not sufficient.
2. Confirm the resulting upstream commit. If squash/rebase merging changed the
   consumed SHA, update `package.json` and `bun.lock` together to that commit.
   Verify that Clanky's final pin is reachable from webapp `main`; an unchanged,
   main-reachable SHA needs no repin.
3. Validate Clanky against the final pin, satisfy Clanky's own review, feedback
   and required checks, and only then merge Clanky or enable its auto-merge.

Before merging Clanky, verify the consumed commit in the upstream checkout:

```bash
git fetch origin main
git merge-base --is-ancestor <consumed-sha> origin/main
```

## Webapp skill source of truth

The `webapp` skill is owned by
[`PabloZaiden/webapp/skills/webapp/SKILL.md`](https://github.com/PabloZaiden/webapp/blob/main/skills/webapp/SKILL.md).
Clanky's `.agents/skills/webapp/SKILL.md` is a complete, identical copy, not a
place to maintain local additions.

Whenever adding or changing Webapp-specific guidance, compare both full skills
and combine valid framework guidance in the Webapp repository first. Deliver
that change through the upstream review workflow, then synchronize the entire
skill here, including its version. Never make the change only in Clanky, append
local sections to the copy, or update only the relevant fragment.

Keep Clanky-only instructions and local guide links in this guide, the
[testing guide](testing.md) or [Apple app guide](../apple-apps.md), as appropriate.
Do not put them in the distributable skill. Verify full-file equality after
synchronization, with `WEBAPP_CHECKOUT` pointing to the upstream checkout:

```bash
cmp "$WEBAPP_CHECKOUT/skills/webapp/SKILL.md" .agents/skills/webapp/SKILL.md
```

## Visual validation

Follow the [manual validation policy](testing.md#manual-visual-validation).
For unattended local UI work:

```bash
CLANKY_DISABLE_PASSKEY=true \
  CLANKY_DATA_DIR=/tmp/clanky-ui-validation \
  bun --hot src/index.ts serve
```

Choose a fresh disposable data directory for each validation session.
The demo generator can populate one:

```bash
CLANKY_DISABLE_PASSKEY=true \
  bun tests/test-data-generation/generate-demo-ui-data.ts \
  --data-dir /tmp/clanky-demo
```

The devcontainer installs SF Pro regular/italic for Apple-platform previews,
not production distribution. Liberation and Noto Color Emoji remain fallbacks.
Rerun `.devcontainer/install-prerequisites.sh` for existing containers; matching
font installations are reused and failures stop setup. Font files and Apple's
license stay outside the checkout and production images. Review the pinned
download checksum/extraction paths when updating the Apple package. Linux
rendering can still differ from Safari despite using the same font family.

### Bun.WebView browser selection

Shared browser-selection and startup diagnostics belong to the
[canonical Webapp skill](https://github.com/PabloZaiden/webapp/blob/main/skills/webapp/SKILL.md#headless-browser-validation-with-bunwebview),
with a [local copy](../../.agents/skills/webapp/SKILL.md#browser-selection-and-startup-diagnostics).
Follow the [upstream-first, full-file synchronization workflow](#webapp-skill-source-of-truth).
Do not maintain a separate generic procedure here.

### Markdown rendering

File preview, chat, and logs share `MarkdownRenderer`. Check unsaved edits,
undo across views, diagram errors, raw mode, and theme changes with disposable
WebView tooling. Code-block copy must return the whole block without fences
or trailing whitespace; the upper-right copy control stays visible during
horizontal scrolling. Check actual technical text remains 16px.

When upgrading Mermaid, render the first diagram **after** Monaco initializes
in both development and the standalone binary. A dependency's interaction with
Monaco's AMD loader must not be worked around by changing the global loader.
Keep diagram measurement free of transitions that interpolate SVG geometry.
