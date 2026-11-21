# Themes

Open **Settings > General > Appearance** to choose a theme. **Color mode**
keeps Light, Dark and System independent of the theme.

Select a gallery card to preview the whole app. Choose **Apply theme** to keep
it, or **Cancel preview** to return to the saved appearance. Leaving Settings
also cancels an unapplied preview. **Reset to Clanky** previews the original
appearance without deleting imported themes; apply it to keep the reset.

Theme selections and imported themes are saved to your Clanky account.
Saved theme and color-mode changes update open clients without reloading;
an unapplied preview is preserved.
Workspace-invitation browser clients without a Clanky account save them only
in that client profile.

## Import, edit and share

Choose **Export theme** to download the selected theme as a
`.clanky-theme.css` file. Edit it in a text editor, then choose **Import theme**.
Imports are previews until you choose **Apply theme**. The library holds up to
20 custom themes; removing one requires confirmation and is also applied with
**Apply theme**.

Existing themes still work. An exported built-in theme provides a starting
palette. To style specific components, write standard CSS. It applies to the
web interface, including the web content in the Apple apps, but not native
controls or the contents of sandboxed chat artifacts. Themes are CSS, not
JavaScript, and the browser applies its ordinary resource policies.

Older token-only palettes retain their light and dark behavior. If a
stylesheet containing only `:root` and `:root.dark` token declarations should
use normal CSS cascade rules instead, add the `Clanky CSS theme:` comment shown
below.

For example:

```css
/* Clanky CSS theme: Ocean */

:root {
  --wapp-sidebar-bg: #e4eff5;
  --wapp-content-bg: #f5fafc;
}

:root.dark {
  --wapp-sidebar-bg: #101f2a;
  --wapp-content-bg: #152937;
}

[data-message-role="assistant"] {
  line-height: 1.65;
}

@media (min-width: 900px) {
  [data-clanky-composer] { padding-inline: 1rem; }
}
```

Use `#wapp-sidebar` for the sidebar, `[data-clanky-chat]` for the conversation,
`[data-message-role="user"]` or `[data-message-role="assistant"]` for message
rows, `[data-message-bubble="user"]` for user bubbles, and
`[data-clanky-composer]` for the composer. Other internal classes may change.
Check readable text, borders, focus and selected states in both color modes
before sharing.

## Open without a theme

If a theme makes Settings inaccessible, open Clanky without the theme:

- **Browser:** add `?safe-theme=1` to the Clanky URL, before any `#` fragment.
  If the URL already has a query, add `&safe-theme=1` instead.
- **Mac:** choose **Clanky > Open Without Theme**.
- **iPhone or iPad:** touch and hold the Clanky app icon and choose
  **Open Without Theme**.

The original styling loads without deleting your themes or changing the saved
selection. To recover, choose another theme or **Reset to Clanky**, then
**Apply theme** and **Resume themes**.
