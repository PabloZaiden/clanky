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
Show/Hide sidebar and Settings have higher native visibility priority than the
other toolbar controls, without changing their order or system-managed spacing.
Pages without actions leave no empty toolbar group reserving space.
They invoke the same web callbacks; Swift does not implement their
business logic. Native actions use the current published state, so changing a
label or active state does not invalidate a visible control. Native button and
menu views observe the published state directly, so loading indicators and
enabled states do not retain their initial values. Route changes recreate the
controls without reloading the WebView. Callbacks from previous routes and
actions that are removed, disabled or busy remain rejected.
Busy actions show a disabled hourglass in their existing slot, not a native
progress view that can introduce a second toolbar across the bottom.
Indicators remain visible. Other layouts keep the web controls.
The composer combines its ordinary bottom spacing with safe-area clearance
using the greater of the two, not their sum.

The Xcode project requires Xcode 27.1+ and targets macOS 14+ and iOS/iPadOS 17+.
Physical-device and Apple Silicon simulator iOS apps can also be cross-compiled
on Linux with Swift 6.4+ and xtool 1.24.0, using an SDK prepared from Xcode 27.1.
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

Both Xcode targets use the checked-in `AppIcon` asset catalog for Clanky's
native app icon, including Finder/Dock on Mac and the iPhone/iPad Home Screen.
These native icons are separate from web favicon and manifest assets.
The Linux build packages the iOS PNG from that same catalog through xtool.
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
An owned process that failed its startup health check still offers **Stop Local
Controller**, including after an interrupted or timed-out shutdown. **Connect**
is available only after a successful health check, and is disabled once shutdown
starts.
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

### Compile on Linux; simulate or sign and install on a Mac

The Linux workflow compiles both the web UI and the Swift shell. It does not
need an Apple account or signing key on Linux. It preserves the Xcode workflow
and reuses its shared Swift sources, Debug iOS settings, permissions and icon
artwork; generated SwiftPM/xtool configuration and build output stay under
`dist/apple/`. The executable records the installed SDK version separately from
the minimum iOS version, preserving iOS's linked-SDK behavior.

Keep application builds and repository validation on Linux for this workflow.
Transfer only the complete built app and its checksum to the Mac for simulation,
visual checks, signing, packaging and installation. The signing Mac does not
need a Clanky checkout, Bun or application dependencies; their absence is
expected, not a reason to relocate compilation or install the build toolchain
there. Choose the separate native Xcode development workflow explicitly rather
than silently switching to it.

The default Ubuntu 24.04 devcontainer installs Swift 6.4.2, xtool 1.24.0 and
their Linux build dependencies for amd64 or arm64. Existing containers can run
`bash .devcontainer/install-prerequisites.sh` to install the same tools.
The installer verifies Swift's official archive signature against a keyring
containing only the pinned Swift release key and its subkeys, and verifies
xtool's release checksum. It unpacks xtool without requiring FUSE and exposes
the tools on PATH.
Repeated setup reuses the versioned installations and does not remove SDKs.

Outside the devcontainer, install Swift 6.4+ and xtool using the
[xtool Linux guide](https://github.com/xtool-org/xtool/blob/main/Documentation/xtool.docc/Installation-Linux.md).
The licensed Apple SDK is separate from the public tools: it is not included in
the devcontainer or committed to Git. Install it as the Linux user that will
run builds, and restore it from a private archive after rebuilding a container
unless its SDK storage is persisted.
For unsigned builds, install the SDK without running `xtool setup` or logging
into Apple through xtool.

A Mac is not required to prepare the SDK. Download Xcode 27.1+ from
[Apple's authenticated download page](https://developer.apple.com/download/all/?q=Xcode)
through your browser and accept its license, then supply the private archive
directly on Linux:

```bash
xtool sdk install --slim /path/to/Xcode.xip
xtool sdk status
swift sdk list
```

Slim SDKs use less space but must be reinstalled rather than updated in place.
An existing Mac Xcode installation can also supply the SDK without another
authenticated download. With xtool available on the Mac, prepare an SDK for
your Linux build architecture (`x86_64` or `arm64`).
For a downloaded macOS `xtool.app`, use its
`Contents/Resources/bin/xtool` CLI launcher, not the GUI executable under
`Contents/MacOS/`.
Replace the paths and architecture placeholder below:

```bash
XCODE_APP="/path/to/Xcode.app"
SDK_OUTPUT="/path/to/sdk-output"
mkdir -p "$SDK_OUTPUT"
xtool sdk build "$XCODE_APP" "$SDK_OUTPUT" --arch "<linux-architecture>"
COPYFILE_DISABLE=1 tar -czf /path/to/darwin.xtoolsdk.tar.gz \
  -C "$SDK_OUTPUT" darwin.xtoolsdk
```

Transfer the archive privately to Linux and verify its checksum.
Do not publish the SDK or commit it to Git.
`COPYFILE_DISABLE=1` avoids macOS AppleDouble metadata, which otherwise appears
as invalid extra platforms to the Linux build system.

On Linux, extract and install that SDK, then build from the repository root:

```bash
tar --exclude='._*' -xzf /path/to/darwin.xtoolsdk.tar.gz -C /path/to/sdk-directory
xtool sdk install /path/to/sdk-directory/darwin.xtoolsdk
bun install --frozen-lockfile
bun run build:apple:ios:linux
```

The output is `dist/apple/ios-linux/xtool/Clanky.app`, an arm64 physical-device
app, not a simulator build. It still needs development signing and provisioning;
an unsigned build is not installable merely by downloading it on the phone.
Copy the whole app to the signing Mac, preserving its contents and verifying
the transfer checksum. Keep the same Apple team and app identity for updates.

To build for an Apple Silicon iOS simulator instead, use the same Linux
toolchain and the SDK's iPhoneSimulator platform:

```bash
bun run build:apple:ios:simulator:linux
```

The output is `dist/apple/ios-simulator-linux/xtool/Clanky.app`. This is an
arm64 `IOS_SIMULATOR` artifact, distinct from the physical-device app even
though both executables use arm64. Transfer the complete app privately and
verify its checksum before installing it on the simulation Mac.

#### Container builds

An existing Linux Swift/xtool installation can be reused in a container.
First install the repository's locked dependencies and run
`bun run build && bun run test` on the source host. Use a Swift 6.4+ image and
Linux Bun/xtool binaries matching the container's architecture.

Set `PROJECT` to the checkout, `XTOOL_ROOT` to the complete xtool installation
containing `tools/bin/xtool`, `SDK_HOME` to the home containing the installed
Darwin SDK, and `SWIFT_IMAGE` to the selected image. Adjust the installation
layout if necessary; preserve any relative CLI dependencies when mounting it.
Then build the simulator app:

```bash
set -euo pipefail
BUN_BINARY="$(command -v bun)"
docker run --rm \
  -v "$PROJECT:/project" \
  -v "$XTOOL_ROOT:/experiment" \
  -v "$SDK_HOME:/root" \
  -v "$BUN_BINARY:/usr/local/bin/bun:ro" \
  -e "GITHUB_SHA=$(git -C "$PROJECT" rev-parse HEAD)" \
  "$SWIFT_IMAGE" /bin/bash -lc '
    set -eu
    export PATH="/experiment/tools/bin:/usr/local/bin:$PATH"
    cd /project
    bun run build:apple:ios:simulator:linux
  '
```

Use `bun run build:apple:ios:linux` in the same container for the physical-device
artifact. Writable project/SDK-home mounts let build output and compiler caches
persist without installing build dependencies on the signing Mac. Pass the
source revision explicitly when a worktree's Git metadata lives outside the
mounted checkout. Record uncommitted source changes too: a commit ID alone does
not identify a dirty build.

#### Transfer built bundles

Archive the complete `.app`, preserving its executable permissions and resource
layout. Keep simulator and physical-device artifacts separate. For example,
on Linux after a simulator build:

```bash
set -euo pipefail
REV="$(git rev-parse --short=12 HEAD)"
BUILD="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_DIR="$HOME/.cache/clanky/apple-artifacts"
mkdir -p "$ARTIFACT_DIR"
ARCHIVE="$ARTIFACT_DIR/Clanky-simulator-$REV-$BUILD.tar.gz"
tar -czf "$ARCHIVE" -C dist/apple/ios-simulator-linux/xtool Clanky.app
sha256sum "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
git diff --binary HEAD > "$ARTIFACT_DIR/source-$REV-$BUILD.patch"
```

For a physical build, archive `dist/apple/ios-linux/xtool/Clanky.app` with a
distinct device-artifact name. Keep source patches and other local-only metadata
private; transfer only the intended app archive and its checksum.

For registered Clanky hosts, use the authenticated file explorer with execution
host targets: download the archive from the source host's artifact directory and
upload it into the destination host's artifact directory. Select each directory
explicitly; the source cache above is outside the workspace checkout. Enable
hidden-file visibility when browsing `.cache/`. This browser-owned binary
transfer is separate from native command execution; raw upload/WebDAV protocols
are not JSON control operations. Do not invent a JSON binary-upload workaround
or an API-credential bridge. A different transfer transport requires its own
approval.

Verify against the trusted source digest before extraction on the Mac. Use a
fresh destination instead of partially overwriting an old bundle:

```bash
set -euo pipefail
ARCHIVE="/path/to/received-app.tar.gz"
DEST="/path/to/new-artifact-directory"
EXPECTED_SHA256="<trusted-source-sha256>"
ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  printf 'App archive checksum mismatch\n' >&2
  exit 1
fi
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  printf 'Artifact destination already exists\n' >&2
  exit 1
fi
mkdir -p "$DEST"
tar -xzf "$ARCHIVE" -C "$DEST"
test -d "$DEST/Clanky.app"
```

The trusted archive should contain only the intended `Clanky.app` tree.
Native signing changes the Mac copy; do not compare its post-signing bytes to
the original unsigned Linux bundle and mistake that change for transfer damage.

#### Run and inspect the simulator

That Mac or macOS VM needs only Xcode 27.1+ and a compatible installed iOS
CoreSimulator runtime, not a Clanky checkout, Bun or its dependencies.
Complete Xcode's first-launch setup and install the desired iOS runtime;
the SDK alone does not include a runnable simulator. License acceptance and
any administrator prompts remain the user's responsibility. Xcode can live
in a user-owned location; set `DEVELOPER_DIR` to the selected app's
`Contents/Developer` instead of changing the system selection.
Check that the intended model can actually be created with the installed
runtime; appearing in `simctl list devicetypes` alone does not establish
compatibility. Select a compatible runtime for the intended model; do not
substitute a different model to claim its layouts were validated or edit
Apple's compatibility metadata.

No Apple Developer account is required for simulation. Use the installed
Xcode's Developer directory, list the available device types/runtimes and
create or select the intended simulator. Boot it once if it is shut down.
The Linux simulator bundle is unsigned: apply a native ad-hoc signature to
the transferred Mac copy before installing. This does not use an Apple
development identity or make the physical-device artifact installable.

```bash
export DEVELOPER_DIR="/path/to/Xcode.app/Contents/Developer"
xcrun simctl list devicetypes
xcrun simctl list runtimes
xcrun simctl list devices available
codesign --force --sign - --timestamp=none /path/to/simulator/Clanky.app
codesign --verify --strict --verbose=2 /path/to/simulator/Clanky.app
xcrun simctl bootstatus "<simulator-identifier>" -b
xcrun simctl install "<simulator-identifier>" /path/to/simulator/Clanky.app
xcrun simctl launch --terminate-running-process "<simulator-identifier>" com.clanky.app
open "${DEVELOPER_DIR%/Developer}/Applications/DeviceHub.app"
```

For a new simulator, select its device type and runtime from the available
lists, create it once and boot the returned identifier:

```bash
xcrun simctl create "<simulator-name>" \
  "<device-type-identifier>" \
  "<runtime-identifier>"
xcrun simctl boot "<simulator-identifier>"
```

Do not recreate or erase the device to install subsequent builds.

In current Xcode, **Xcode > Open Developer Tool > Device Hub** opens the
interactive device canvas; the legacy `Simulator.app` path is not required.
For a foldable simulator, use its pose controls to inspect the intended
layouts. See [Apple's Device Hub interaction guide](https://developer.apple.com/documentation/xcode/interacting-with-your-app-in-device-hub).

Some simulators have multiple displays. Use
`xcrun simctl io "<simulator-identifier>" enumerate`
to inspect their IDs and powered state, then select a display explicitly:

```bash
xcrun simctl io "<simulator-identifier>" screenshot --type=png \
  --display="<screen-identifier>" /path/to/simulator.png
```

Change the pose before reviewing the other display. A screenshot of an inactive
display can be black; capturing both IDs without unfolding is not validation
of both layouts.

Retrieve or preview PNGs through the authenticated file explorer or an approved
transfer. A successful launch/process ID is not visual validation. Record which
device, pose and display were actually reviewed; if capture/review is unavailable,
state that limitation instead of claiming the layout passed.

Keep the chosen simulator and install later builds on that same device to
preserve its app data. A physical iPhone cannot install this simulator artifact.
Native signing still requires the account, certificate and provisioning
requirements below. A private-NAT VM does not automatically discover a real
iPhone on the host's Wi-Fi: use a reachable paired Mac for network deployment
rather than assuming simulation or signing establishes physical-device
connectivity.

For wireless installation:

1. Put the Mac and iPhone on the same local network. In Xcode, open
   **Manage Devices > Device Hub**. On iOS/iPadOS 27+, use
   **Add Device > Pair Nearby Device** for initial wireless pairing. Older
   versions need a cable for the first pairing. Enable Developer Mode and
   accept the trust/pairing prompts on the phone. For subsequent Wi-Fi runs,
   Apple requires a compatible network with IPv6 enabled; a routed VPN alone
   is not a substitute for local device discovery. See
   [Apple's pairing guide](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub).
2. Set up native development signing in Xcode on the Mac: add your Apple
   account, select its team for **Clanky-iOS**, and use automatic provisioning
   for the intended phone and a unique bundle identifier. An **Apple
   Development** certificate with its private key and a valid device development
   profile must be available before signing can proceed. A free Personal Team
   is sufficient. Keep the keys on the Mac; no Apple login is needed on Linux.
3. Use Apple's `codesign` to sign the existing Linux-built app. First verify
   that the profile is unexpired, authorizes this phone and signing certificate,
   and matches the app's bundle identifier. Embed it as
   `Clanky.app/embedded.mobileprovision` and prepare development entitlements
   permitted by that profile. The application/team identifiers must match;
   do not copy wildcard entitlements unchanged or silently change the app ID.
4. Verify the signature, then use Apple's `devicectl` installer. Neither step
   recompiles the app or depends on xtool finding the phone.

#### Physical signing and installation gates

Before using the commands below, check the intended Mac's currently usable
development identities with `security find-identity -v -p codesigning`.
An ad-hoc simulator signature is not an Apple Development identity.
Decode a selected profile locally with
`security cms -D -i /path/to/profile.mobileprovision` and verify its expiration,
provisioned device, developer certificate and authorized application identifier.
Keep decoded account/device details in private local storage, not shared guides.

Prepare entitlements from the matching provisioning configuration. App identifier
prefixes, team identifiers, keychain groups and development permissions must
match what the profile authorizes; do not assume every prefix equals the team
ID or copy wildcard entitlements unchanged. If the selected team cannot use the
current bundle ID, obtain approval to change it and rebuild from the authoritative
project settings instead of silently patching the signed bundle.
Confirm that the artifact is the physical-device build, not the simulator build.

Account setup, certificate/profile creation, keychain access, pairing and actual
phone installation require fresh user approval where applicable. Use private
OS prompts for account passwords and keychain unlocks; never put them in command
arguments or note files. Check current device connectivity again immediately
before installation; being on a reachable LAN alone does not prove pairing.

With the matching profile and entitlements already prepared:

```bash
cp /path/to/profile.mobileprovision /path/to/Clanky.app/embedded.mobileprovision
codesign --force --sign "<Apple Development identity>" \
  --entitlements /path/to/Entitlements.plist /path/to/Clanky.app
codesign --verify --strict --verbose=2 /path/to/Clanky.app
xcrun devicectl list devices
xcrun devicectl device install app --device "<device-identifier>" /path/to/Clanky.app
```

These commands normally run as the Mac's ordinary user, without `sudo`.
Administrative privileges cannot replace a missing Apple signing identity or
profile. A locked signing keychain may still require the user's interaction.
On an artifact-only signing host, Xcode's Accounts settings can create the
development certificate, but a matching provisioning profile is still required.
Automatic provisioning requires an Xcode project with the intended bundle
identifier; it can be a separate minimal signing-only project, rather than a
Clanky checkout or a Mac-side Clanky build. Keep the actual Linux-built app's
identifier and entitlements aligned with that profile.
Account/team setup can be performed through remote desktop; being physically
at the Mac is not required, but credentials, two-factor codes and private keys
must not be sent to an agent. Open Clanky on the phone after installation
succeeds.

xtool is optional for Mac signing/deployment. Its device discovery is separate
from Apple's CoreDevice: a phone paired and connected in `devicectl` can still
be absent from `xtool devices --network --no-wait`. Do not wait indefinitely in
`xtool install --network` when its discovery list is empty; use the native
signing/installation route above.

Neither a successful cross-build nor a visible simulator proves physical-device
installation. Missing development signing, an unpaired phone or unavailable
network discovery must be resolved before claiming deployment. Free-account
expiry and app/device limits still apply. In the installed app, connect to the
existing Clanky API's reachable HTTPS address, not the build Mac's loopback
address.

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

All UI assets, including fonts, Monaco and its workers, are bundled. On iOS,
a verified downloaded frontend can replace that bundled UI as described below.
A small Swift HTTP listener serves only the selected frontend on `127.0.0.1` using the
installation's saved port. This is not
a local Clanky controller, proxy or API. Both platforms need this loopback web
origin to preserve secure-context Web Crypto, IndexedDB, Web Locks and worker
behavior without private WebKit APIs or `file://` workarounds. The port/origin
stays fixed after its initial allocation so reopening the app does not
silently lose saved sessions and invitation identities. All windows share that
origin. The initial port is allocated by the operating system while binding
the listener, not guessed using a separate availability check. The Mac app
does not allocate its optional controller's port for assets.
Derive browser bootstrap and native presentation/caller guards from that saved
origin rather than independently hard-coding their addresses.
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
API resource downloads use the framework's explicit native-save handoff after
the existing selected-server validation and ticket acquisition. The native host
checks the calling local frontend document and allows HTTPS destinations or loopback
HTTP without receiving API bearer credentials. Acceptance starts WebKit's
download flow; it does not mean that a file has already been saved.
Content popups such as **Open image in a new tab** appear in a closable in-app
sheet. Authorization popups still hand their external URL to the system browser
and dismiss the temporary sheet.
Validate native bridge payloads before Foundation `JSONSerialization`; scalar
roots can raise an Objective-C exception rather than a catchable Swift error.
The invited client's **Ready to export** still means browser storage, not a
confirmed save to Files/Downloads. Platform storage/export limits still apply.

There is no background execution, background transfer, offline synchronization
or new automatic-retry guarantee. On iPhone/iPad, keep the app in the foreground
for active transfers; suspension may interrupt connections. If the app reports
that it stopped responding, choose **Try Again** to reconnect.

### Frontend updates on iPhone and iPad

On a fresh iOS process launch, before opening the WebView, the app checks
`https://pablozaiden.github.io/clanky/build-info.json`. An unchanged frontend
manifest digest needs no asset download, installation or confirmation.
A published frontend also skips rebuilds of its already installed source
revision, even if bundler details or the resolved version/timestamp change.
Development frontends do not use that shortcut because they may include
uncommitted changes. `builtAt` alone never triggers an update. Returning from the background,
reloading the web page, opening another scene and retrying the local asset
server do not initiate another update check in that process.

When a different frontend is available, the app prepares it during that same
startup and opens the updated UI. The version used to detect development
builds is the frontend version shown in the sidebar, not the backend or native
bundle version. It originates in `package.json.version`, is passed through
`CLANKY_VERSION`, and is embedded in each mode's `webapp-client.json` and the
site's build metadata. The checked-in `0.0.0-development` version retains its
`-development` marker in local builds; Pages CI resolves a published version
before packaging. An active version with that development marker offers
**Update** or **Keep Current** before downloading the update. Keeping it asks
again on a later cold launch if a different deployment is still available.
Once the active frontend is a published version, updates are automatic.
Xcode's Debug configuration is not the development-build criterion.

Downloads use the existing Pages assets and their manifest's byte sizes and
SHA-256 hashes. Identical verified local assets are reused, including assets
shared between connection modes. The complete snapshot is prepared in private
Application Support storage and selected atomically, never written into the
signed app bundle. The active snapshot stays fixed while the process runs.
The selection retains the previous downloaded snapshot as well as the bundled
frontend. A newly installed app with a different bundled frontend starts from
that bundle rather than an older app's downloaded selection.

The initial metadata check has a five-second deadline; preparing an update
has a two-minute deadline. An interrupted or invalid download leaves the
installed frontend selected. Startup and cleanup errors are logged and shown
explicitly; inability to reach Pages does not prevent opening a usable local
frontend. Before restoring a saved snapshot, the app verifies every
manifest-listed asset's type, byte size and SHA-256, including when Pages has
not changed. A missing or invalid saved snapshot falls back to a verified
previous snapshot when available, otherwise to the bundle. Sessions and invitation
identities remain in the same WebKit storage because the saved loopback origin
and client paths do not change.

The app trusts the published Pages frontend as application code. It currently
does not check compatibility with the native shell or connected backend.
Native-code/permission changes and expired development provisioning still
require installing/signing the app again. macOS remains bundle-only and its
embedded CLI/controller update behavior is unchanged.
