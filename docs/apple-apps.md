# Apple apps

Clanky's Apple app is a thin SwiftUI + WKWebView shell around the existing
web client. macOS, iPhone and iPad use the same bundled web UI, API client,
invitation protocol and persistent web storage. There is no separate native
authentication implementation or custom Keychain credential store.
The web UI owns the screen and its navigation: the shell adds no browser toolbar,
Home/Reload buttons or duplicate app heading.
On iPhone/iPad the WebView fills the entire window, in both dimensions,
including behind a Duo's side status area and the home indicator. Its background
follows the web page's color, without separate native-color bands. The shared web
framework protects headers and route content from system overlays; the connection
chooser and conversation composer handle their own safe-area clearance.
Do not also constrain the WebView to native safe areas, which would apply the
insets twice. WebKit handles the on-screen keyboard without a second SwiftUI
resize. Rotation, folding and window-size changes use native layout constraints
and web safe-area values, not fixed device dimensions. System indicators remain
visible; edge-to-edge backgrounds do not mean placing controls underneath them.
The shared shell follows the keyboard's visual viewport even when a tablet or
unfolded Duo uses its wide layout, keeping the composer above the keyboard and
restoring the full height when it closes.

On iOS 27.1, the host also reports public system-reserved regions to the shared
shell. When a top status area occupies only a corner, the web header uses the
free part of that row instead of adding a second row beneath it. Camera and
indicator regions remain clear; ordinary notches and unsupported layouts keep
the normal safe-area fallback. Opening the mobile sidebar focuses navigation,
not Search; tapping Search or explicitly requesting search still focuses it.

In iOS 27.1 modes with a system side bar, existing sidebar actions and page
actions use the native toolbar, anchored at the bottom. They replace their web
counterparts, including the logo/Home button, and remove the entire sidebar
header row. The same bundled PNG logo is used on web and in the native bar.
Native controls have no shared capsule/background; they keep the system's
bottom-anchored placement and native interactions.
They invoke the same web callbacks; Swift does not implement their
business logic. Indicators remain visible. Other layouts keep the web controls.
The composer combines its ordinary bottom spacing with safe-area clearance
using the greater of the two, not their sum.

The project requires Xcode 27.1+ and targets macOS 14+ and iOS/iPadOS 17+.
Build tools require Bun and the repository's dependencies; installed apps
do not require Bun, Node, a frontend server installation or a preinstalled
Clanky CLI.

## Build for Mac

From the repository root:

```bash
bun install --frozen-lockfile
bun run build:apple:macos
open dist/apple/build/Build/Products/Debug/Clanky.app
```

The command builds the existing two-mode static site, the standalone CLI and
the native app. Copy the complete `Clanky.app` anywhere on the same Mac, or to
a compatible Mac of the same architecture. No installer is needed. This build
is ad-hoc signed, not Developer ID signed or notarized; it is a development
artifact, not a Gatekeeper-approved public distribution. It does not publish
a release or change the existing CLI's release/update process.

For iterative Swift work, open `native/Clanky.xcodeproj`, select
**Clanky-macOS**, and run. Regenerate bundled resources after web/CLI changes
with the command above. Xcode fails the build if required resources or the
standalone helper are missing. Generated resources live under `dist/apple/`,
not in the source tree. The build targets the host architecture; it does not
produce a universal Mac controller.
The embed step rejects an app architecture not supported by the prepared CLI.
Debug Run builds only the active Mac architecture, matching the bundled helper;
Release builds still require a helper supporting every requested architecture.
Replace/rebuild the whole app to update it; running CLI self-update against
the embedded helper would modify the signed bundle and is not an app updater.

Both Apple targets use the checked-in `AppIcon` asset catalog for Clanky's
native app icon, including Finder/Dock on Mac and the iPhone/iPad Home Screen.
After changing `src/logo.png`, regenerate those native assets on macOS with
`swift scripts/generate-apple-icons.swift` and rebuild the apps. The generator
keeps transparent clearance for Mac and produces an opaque square for iOS,
which applies its own icon mask. It does not sign or launch apps.

### Windows and local controller

**File > New Window** (`Cmd+N`) opens another native window. The window has no
extra title or navigation toolbar; the standard macOS window controls remain.
Windows share ordinary WebKit website data, just as browser tabs do. There
is no new native profile system. An invited pairing still supports only one
owning document at a time; close its other window before reconnecting.

The macOS menu bar's **Local Controller > Start Local Controller** starts the
bundled existing CLI with `serve --api-only true`, then connects the API client
to it after its health check succeeds. **Connect to Local Controller** connects
the active window to the running controller. Commands require an active Clanky window and are disabled
while the controller starts or stops. It is optional and never starts just
because the app opens.
All windows share this one app-owned controller. Its executable is
`Clanky.app/Contents/Helpers/clanky`, separate from the native app executable.
It can also be used as the regular Clanky CLI from Terminal.

The local controller binds to `127.0.0.1:49372`; its browser/API address is
`http://localhost:49372`. Its data and logs are under:

```text
~/Library/Application Support/<app-bundle-identifier>/Controller/
```

The default identifier is `com.clanky.app`. The app does not import, modify or
stop a separately installed controller or `~/.clanky`. Controller child
processes do not inherit `CLANKY_` overrides from the environment that launched
the app. Startup/exit errors identify the app-controller log. A port already
in use fails visibly rather than attaching to an unrelated controller.

**Stop Local Controller** stops the app-owned process; connected local windows
then lose their API connection. Quitting the app requests normal CLI shutdown
and waits for cleanup. If shutdown does not finish, quitting is cancelled and
an error remains visible; the app does not silently abandon its controller.
The app continues observing that process after an interrupted or timed-out
shutdown. If it exits later, the controller state and log handle are finalized
and starting it again becomes available.
Closing a window is not quitting the app. A forced OS termination cannot run
normal cleanup.

Bundling Clanky removes the need to install its runtime, not the workspace's
own tools. Local Git/provider execution still requires the tools,
authentication and execution-host configuration described in
[harness adapters](harnesses.md). Remote hosts retain their existing
requirements. The app does not install agents, Git or Devbox.

## iPhone and iPad development

The iOS target contains only the client shell and web assets. It does not
include the CLI/controller, spawn subprocesses or execute workspace work
locally.

Prepare assets and open the project:

```bash
bun run build:apple:assets
open native/Clanky.xcodeproj
```

Select **Clanky-iOS**, then:

1. Add your Apple account in **Xcode > Settings > Accounts**.
2. In the iOS target's **Signing & Capabilities**, select your **Personal Team**
   and a unique bundle identifier. Keep automatic signing enabled.
3. Connect and select your iPhone/iPad, enable Developer Mode if requested,
   and run from Xcode. Trust the development identity on the device if prompted.

No paid capabilities, App Groups, iCloud, push or Associated Domains are
required. A free Personal Team is suitable for development, not App Store,
TestFlight or unrestricted distribution. Free provisioning normally expires
after seven days, after which the app needs signing/installing again through
Xcode; Apple's device/app limits also apply.

Build an unsigned simulator app without an Apple account:

```bash
bun run build:apple:ios
```

The output is
`dist/apple/build/Build/Products/Debug-iphonesimulator/Clanky.app`.
It is a simulator artifact, not an IPA installable on a physical device.
Running it requires a compatible installed CoreSimulator runtime; having
the SDK alone is sufficient to compile, not to launch a device.
In Xcode, select **Clanky-iOS**, an installed iPhone/iPad simulator, and Run.
The simulator and Mac app share the host's loopback network. Each installation
chooses its own available asset port on first startup and keeps it afterward,
so Mac and simulated clients can run together. Physical devices have their own
loopback network.

## Connections and web behavior

On first use, choose **Connect to an API** or **Connect through collaboration**.
Reopening the app or creating a window goes directly to the last selected mode,
including an unfinished connection/login flow. Existing web storage resumes the
API session or invited connections; Swift remembers only the mode, not remote
URLs, credentials, invitations or the last chat. Windows share this preference;
the most recently opened mode is used for the next window, not forced on others.
When updating from a build that did not remember modes, select one once; its
existing web session is reused.
Development builds that previously shared the fixed asset port `49371` need
API authorization or invitation acceptance once again when moving to the
per-installation origin. The old website data is not deleted or copied into
Swift. Subsequent launches and updates reuse the saved origin and its sessions.

Use **Settings > General > Connection > Change connection** to return to the
chooser without signing out or removing pairings. The API connection/sign-in
screen also has this link, so an unavailable server or unfinished login cannot
trap the app in one mode. Returning to the chooser clears the startup selection.
The optional Mac local-controller mode is remembered separately and still
requires **Start Local Controller** after quitting; restoration does not start
the controller automatically. Ordinary static-site/browser startup is unchanged.

API login
uses the existing device-authorization flow: the shell opens the system browser,
you authenticate on the controller's origin with its normal passkeys, and the
existing client completes authorization. Passkeys are not requested for the
bundled UI's local origin. Remote APIs require HTTPS; loopback development
APIs may use HTTP.

For collaboration, choose the owner's `.clanky-invite.json` file in the existing
web form. Validation, pairing, grants and Direct/Relay routing are unchanged.
See [static clients](static-client.md#browser-only-collaboration) for their
capabilities and limitations.

All UI assets, including fonts, Monaco and its workers, are bundled. A small
Swift HTTP listener serves only those assets on `127.0.0.1` using the
installation's saved port. This is not
a local Clanky controller, proxy or API. Both platforms need this loopback web
origin to preserve secure-context Web Crypto, IndexedDB, Web Locks and worker
behavior without private WebKit APIs or `file://` workarounds. The port/origin
stays fixed after its initial allocation so reopening the app does not
silently lose saved sessions and invitation identities. All windows share that
origin. The initial port is allocated by the operating system while binding
the listener, not guessed using a separate availability check. The Mac app
does not allocate its optional controller's port for assets.
If another process later occupies a saved port, startup fails explicitly:
the app does not attach to that process or silently choose a different origin.
Separate saved installations initialized at different times can still encounter
such a collision; a persisted port is not a permanent operating-system reservation.

Credentials remain in the existing web client's persistent storage; invitation
private keys retain their existing nonextractable Web Crypto storage. As with
the browser client, trusted application JavaScript can access its own sessions.
API, invitation and app-local-controller paths retain separate client storage
namespaces; paths are not security boundaries. Replacing the bundle preserves
website data for the same app identity. Clearing that data or changing the app
identity may lose sessions and pairings.

External top-level links open in the system browser. File selection uses WebKit's
native picker; downloads use the Mac save panel or iPhone/iPad export sheet.
The invited client's **Ready to export** still means browser storage, not a
confirmed save to Files/Downloads. Platform storage/export limits still apply.

There is no background execution, background transfer, offline synchronization
or new automatic-retry guarantee. On iPhone/iPad, keep the app in the foreground
for active transfers; suspension may interrupt connections. If the app reports
that it stopped responding, choose **Try Again** to reconnect.
