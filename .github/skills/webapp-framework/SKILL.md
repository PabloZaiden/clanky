# Webapp framework skill

Use this skill when working on Clanky code that touches app foundations.

## Rules

- Clanky uses `@pablozaiden/webapp` for shared server, auth, settings, shell, sidebar, and realtime foundations.
- Keep Clanky as one Bun app and one binary. The server is `clanky serve`; CLI commands are `clanky auth`, `clanky status`, `clanky api`, `clanky schema`, `clanky ws`, `clanky update`, and `clanky version`.
- Do not reintroduce separate web/server/CLI app boundaries unless there is a real package boundary. `clanky-cli` is not part of the target architecture.
- Use `bun --hot src/index.ts serve` for local development so Bun hot reload handles backend and frontend changes in one process.
- Prefer `createWebAppServer`, `defineRoutes`, framework auth modes, framework settings, `WebAppRoot`, framework sidebar nodes, and framework realtime before adding Clanky-specific replacements.
- Do not add app-local shell/header action menus for active entities. Put task, chat, agent, SSH session, workspace and server commands on their route-backed `SidebarNode.actions`; the framework renders the sidebar context menu and active title-bar three-line menu from that single source.
- Use framework `ActionMenu`, `ConfirmModal`/`ConfirmDialog`, `Modal`, and shell components instead of Clanky-local reimplementations. Destructive/delete actions must be marked destructive where possible, render red, stay last, and require confirmation before mutation.
- Sidebar badges are framework-owned compact status dots; do not design sidebar layouts that depend on visible badge text.
- Framework headers own title/action overflow behavior. Keep important actions such as `Back` as header actions and let titles/subtitles truncate instead of clipping buttons.
- Framework dialogs handle Enter as confirm/primary action and Escape as cancel/close; do not add custom modal keyboard handling unless the framework primitive cannot be used.
- Treat app data as private per user. Use the current framework user id for Clanky workspaces, tasks, chats, agents, SSH resources, VNC sessions, forwarded ports, comments, and app-specific preferences.
- New users must start with empty Clanky app data.
- The multi-user database migration has already been deployed; do not reintroduce one-time legacy data backfill code.
- Use app-owned websocket upgrade/proxy handlers only for SSH terminal, VNC, and forwarded-port proxy traffic. Normal app events should use framework realtime.
- Keep Clanky-specific settings only for quick chat, markdown rendering, full file explorer tree, scheduler timezone, last model, last directory, and workspace server settings.
- Keep raw transports app-owned only for SSH terminal, VNC and forwarded-port proxying; normal UI state should use framework realtime and framework shell surfaces.
- Use Playwright for browser walkthroughs and screenshots after UI migration; do not commit Playwright tests unless explicitly requested.
