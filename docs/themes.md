# Themes

Open **Settings > General > Appearance** to choose a theme. **Color mode**
keeps Light, Dark and System independent of the theme.

Select a gallery card to preview the whole app. Choose **Apply theme** to keep
it, or **Cancel preview** to return to the saved appearance. Leaving Settings
also cancels an unapplied preview. **Reset to Clanky** previews the original
appearance without deleting imported themes; apply it to keep the reset.

Theme selections and imported themes are saved to your Clanky account.
Workspace-invitation browser clients without a Clanky account save them only
in that client profile.

## Import, edit and share

Choose **Export theme** to download the selected theme as a
`.clanky-theme.css` file. Edit it in a text editor, then choose **Import theme**.
Imports are previews until you choose **Apply theme**. The library holds up to
20 custom themes; removing one requires confirmation and is also applied with
**Apply theme**.

An exported Clanky default has empty blocks: add supported declarations to
override only the parts you want. Exporting another built-in theme provides
a complete editable palette.

For example:

```css
/* Clanky theme: Ocean */

:root {
  --wapp-sidebar-bg: #e4eff5;
  --wapp-content-bg: #f5fafc;
  --wapp-surface: #ffffff;
  --wapp-primary: #216482;
  --wapp-panel-radius: 12px;
  --wapp-control-radius: 8px;
  --wapp-panel-border-width: 1px;
}

:root.dark {
  --wapp-sidebar-bg: #101f2a;
  --wapp-content-bg: #152937;
  --wapp-surface: #1d3545;
  --wapp-primary: #9bdaf4;
  --wapp-panel-radius: 12px;
  --wapp-control-radius: 8px;
  --wapp-panel-border-width: 1px;
}
```

Keep both blocks. Only supported custom properties are accepted; omitted
properties retain Clanky's defaults. Use hex colors or `transparent`, radii
from 0 to 24px, and border widths from 0 to 2px (`px` and `rem` are supported).
Files must be no larger than 64 KiB. Theme names may contain up to 60
characters, without control characters or asterisks.

Themes cannot load fonts, images, URLs or other stylesheets, use `!important`,
or contain arbitrary selectors, layout rules or scripts. Invalid files leave
the current theme unchanged and show an error. Check readable text, borders,
focus and selected states in both color modes before sharing.

The supported properties and their validation are defined by the
[framework visual-theme contract](https://github.com/PabloZaiden/webapp/blob/341d292f4f6f035cd0e51142c2cd34b8e1a77c0e/docs/settings.md#visual-themes).
