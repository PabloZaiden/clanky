# Apple apps

For installation and everyday Mac-controller, Tailscale and iPhone use without
building or signing apps, start with [Get the most out of Clanky](everyday-use.md).
This guide also covers native development and distribution.

Clanky's Apple app is a thin SwiftUI + WKWebView shell around the existing
web client. macOS, iPhone and iPad use the same bundled web UI, API client,
invitation protocol and persistent web storage. There is no separate native
authentication protocol or custom Keychain credential store. The native process
coordinates credential operations between windows; authorization requests and
credential validity still belong to the shared web client and server.
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
the normal safe-area fallback. Full-height side regions do not remove the
separate top-bar clearance. Opening the mobile sidebar focuses navigation,
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
The shared page-actions menu is labeled **More** and uses the `list.bullet`
symbol on every page. Its semantic icon-and-text label keeps the name visible
when the system moves it into overflow, including with the keyboard open.
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
Apple Silicon macOS apps can use the same Linux tools and Darwin SDK.
Build tools require Bun and the repository's dependencies; installed apps
do not require Bun, Node, a frontend server installation or a preinstalled
Clanky CLI.

## CI builds for main and releases

The [binary build workflow](../.github/workflows/binary-release.yml) also builds
both Apple apps during nightly/manual main publication and published releases,
excluding the rolling `latest` release event. Ordinary main merges do not build,
sign or publish apps. See the [nightly/manual publication entrypoint](binary-updates.md).
The Apple job uses GitHub's Apple Silicon `xcode-27`
runner and selects its installed Xcode 27.1. That runner image is currently in
preview; ordinary `macos-26` images do not provide the required iOS 27.1 SDK.
The SDK stays on the runner: no private SDK archive, Apple login, provisioning
profile or signing certificate is needed for compilation. Mac distribution
signing and notarization run afterward with protected CI credentials.

The job runs `bun run build:apple:macos` and
`bun run build:apple:ios:device`. The Mac bundle includes the standalone
controller and shared web UI; the iOS bundle targets physical iPhones/iPads,
not the simulator. Nightly/manual main runs use Xcode's Debug configuration;
published versioned releases use Release, with the project's optimized Swift
settings.
Archive paths and build metadata follow that configuration, and publication
rejects artifacts built in the wrong mode for the event. Public Mac archives
embed an increasing native build number and their distribution channel/version;
public unsigned iOS archives retain the project's native version numbers.
The bundled frontend and Mac controller embed the exact distribution version: the release tag without `v`,
or the CLI publisher's exact rolling main version. Apple builds wait for CLI
publication so main does not independently generate a different timestamp-based
version. Superseded main commits are skipped. Before signing and packaging,
both connection-mode bootstraps, frontend metadata and integrity manifest must
match that version and source, and the Mac controller must report that version.
Build metadata records the embedded version; publication rejects a mismatch
instead of merely relabeling an archive. Ordinary local builds retain their
development version unless explicitly configured otherwise.
The separate TestFlight IPA uses its release tag and an Apple build number.
Explicit stable-release and TestFlight publication keep their existing behavior.
The optional Linux cross-build commands below remain available independently of CI.

Download `apple-app-macos-arm64` or `apple-app-ios-arm64` from the workflow run's
Actions artifacts; they use the repository's artifact retention policy.
The Mac artifact contains `Clanky-macos-arm64-notarized.zip`, its `.sha256`
file and `build.json`; iOS contains `Clanky-ios-arm64-unsigned.tar.gz` and the
corresponding checksum/metadata. Metadata records the exact source revision/ref,
distribution version, target, configuration and Xcode version. Mac metadata
also identifies the verified signing certificate, team, accepted notarization
submission and stapled ticket. Verify and extract the Mac archive preserving
bundle metadata:

```bash
shasum -a 256 -c Clanky-macos-arm64-notarized.zip.sha256
ditto -x -k Clanky-macos-arm64-notarized.zip .
```

Use `tar -xzf Clanky-ios-arm64-unsigned.tar.gz` for the device app after
verifying its checksum. Once both Apple and
CLI builds succeed, the same app archives are also attached to the rolling
[`latest` prerelease](https://github.com/pablozaiden/clanky/releases/tag/latest)
for nightly/manual main publication and to the exact versioned release for
published-release events.
Each platform has three assets: its versioned archive, `.sha256` file and
`Clanky-v<version>-<platform>-arm64-build.json`. Mac archives are named
`Clanky-v<version>-macos-arm64-notarized.zip`; iOS archives retain
`Clanky-v<version>-ios-arm64-unsigned.tar.gz`.
Download the matching archive and checksum together and verify with
`shasum -a 256 -c <archive>.sha256` before extraction. Metadata identifies the
source revision, release version and archive filename. Main uses the CLI
publisher's exact build version and skips superseded source commits; publication
shares its lock so rolling cleanup preserves the current Apple assets.
Existing Actions artifacts keep their original names. Historical releases are
not backfilled.

Updater-enabled Mac builds also attach
`Clanky-v<version>-macos-arm64-appcast.xml` and
`Clanky-v<version>-macos-arm64-update.json`. The latter is the completion marker
for an uploaded archive/appcast pair; publication verifies their GitHub asset
digests before the feeds are advertised. Older releases without this metadata
are not offered as native updates.

The Mac app, bundled controller and native dynamic libraries are Developer ID
Application signed with Hardened Runtime and secure timestamps, notarized and
verified before upload.
The app's ticket is stapled and validated before the final ZIP is created.
The public iOS archive remains an input for later signing, not an installable
IPA. After all public app/CLI assets succeed, published versioned releases also
archive, sign and publish a separate internal-only iOS build to TestFlight.
Main and rolling `latest` never upload to TestFlight. CI does not submit apps
for public App Store/external beta review, install apps or require the private
signing host.

### CI signing and notarization

Configure these repository secrets before running either channel:

- `CLANKY_MACOS_DEVELOPER_ID_CERT_BASE64`: Base64-encoded encrypted PKCS#12
  containing one valid Developer ID Application certificate, its private key
  and the Apple intermediate chain.
- `CLANKY_MACOS_DEVELOPER_ID_CERT_PASSWORD`: exact PKCS#12 password, including
  any leading or trailing whitespace.
- `CLANKY_APPLE_NOTARY_KEY_P8`: private App Store Connect team API key.
- `CLANKY_APPLE_NOTARY_KEY_ID` and `CLANKY_APPLE_NOTARY_ISSUER_ID`: its key and
  issuer identifiers.

Apple must issue the Developer ID Application certificate through an authorized
Developer Program account. Development, Distribution and self-signed
certificates are not substitutes. Use an authorized App Store Connect API key
for notarization; never put private values in tracked configuration or logs.
CI imports the identity into a job-owned keychain and removes temporary
credentials/keychains. It does not depend on a private Mac or login session.
The old `CLANKY_MACOS_SIGNING_CERT_*` secrets are not used by this workflow.
Use an Apple Security-compatible PKCS#12 export: SHA1 MAC and legacy 3DES
key/certificate encryption. A package can parse correctly in OpenSSL yet fail
Apple's import with a MAC verification error. Verify an import into a temporary
Mac keychain before storing the package in CI; preserve the usual keychains.

`scripts/macos-distribution.ts --notarize <app-or-binary-paths>` owns both
native-app and standalone-CLI distribution verification. Bun executables use
only the `allow-jit` runtime entitlement; the native shell has no runtime
exceptions or development entitlements. Its camera/audio-input resource
entitlements preserve the app's existing declared media-capture capabilities;
system permission prompts and the shell's restricted media-capture policy still
apply. Native libraries have no entitlements and inherit the host executable's
permissions, as described in
[Apple's Hardened Runtime guidance](https://developer.apple.com/documentation/security/hardened-runtime).
Native nested Mach-O code is signed before the outer bundle, including Xcode's
Debug/preview dylibs on main. Acceptance must cover every signed executable's
code hash. Missing credentials, Apple rejection, signature/ticket
verification or credential-cleanup failures block the relevant publication;
there is no unsigned or unnotarized fallback.

Both main and versioned releases currently notarize. Each workflow makes two
submissions: one Mac app (including its controller) and one batch containing
both standalone Darwin architectures. Apple recommends limiting submissions
to 75 per day; nightly/manual main publication and versioned releases consume
this budget, but ordinary main merges do not. See Apple's
[notarization guidance](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

### CI internal TestFlight

The existing iOS Bundle ID must have an App Store Connect app record and an
internal testing group with at least one authorized team member and **Enable
automatic distribution** enabled. Configure these additional repository inputs:

- `CLANKY_IOS_DISTRIBUTION_CERT_BASE64`: Apple Security-compatible encrypted
  PKCS12 containing one valid Apple Distribution identity and its intermediate
  chain. Development and Mac Developer ID identities cannot sign this IPA.
- `CLANKY_IOS_DISTRIBUTION_CERT_PASSWORD`: exact PKCS12 password; whitespace is
  significant.
- `CLANKY_IOS_TESTFLIGHT_PROFILE_BASE64`: App Store Connect distribution profile
  for the current iOS Bundle ID/team and certificate, not Ad Hoc/development.
- Repository variable `CLANKY_IOS_TESTFLIGHT_GROUP`: the existing internal group
  name. Manage its members in App Store Connect; adding internal testers does
  not require new credentials or workflow changes.

The job reuses `CLANKY_APPLE_NOTARY_KEY_P8`, `CLANKY_APPLE_NOTARY_KEY_ID` and
`CLANKY_APPLE_NOTARY_ISSUER_ID` as the existing team App Store Connect API key.
A Developer-role key can upload builds; it must actually have access to the app,
group and build APIs. Keep unrelated signing/OTA credentials and profiles intact.

`bun scripts/ios-testflight.ts vX.Y.Z[-prerelease]` owns the publication:
it passes the full release version to the canonical bundled-web build without
changing `package.json`, creates a native Release
`xcodebuild archive`, and exports with `app-store-connect` and
`testFlightInternalTestingOnly=true`. Native marketing version is the numeric
release core; the next major build number comes from Apple's existing builds
for that version. The shared CI concurrency queue serializes uploads, including
reruns, so the same marketing/build pair is never deliberately reused.
Xcode's automatic version/build management is disabled.

Both archive and extracted IPA must match the actual iOS Bundle ID, release
version/build, arm64 device platform, exact profile and signing certificate,
and authorized non-development entitlements. Their bundled frontend metadata,
integrity manifest and both connection bootstraps must match the checked-out
source and full release version, including any prerelease suffix. TestFlight
never ships the default development frontend merely because the checked-in
package version has that marker. Both apps must contain the checked-out iOS
Settings bundle with stable as the default frontend channel. The exported app declares no
non-exempt encryption: native hashing, client signing and transport use
CryptoKit/Web Crypto/system networking. Reassess this declaration before adding
cryptography not provided by the operating system.

The Apple upload is followed by bounded processing and internal-readiness
verification. The selected internal group must still have automatic distribution
enabled and at least one tester when the build is ready. This automatic-only
flow does not manually assign build/group relationships, which Apple can reject
for internal-only uploads even when the build is already available.
Apple rejection, compliance/credential/signature problems or timeout
fail the job, with no automatic uncertain upload retry or unsigned fallback.
The build cannot be used for external TestFlight or public App Store submission.
Only a non-secret result goes to the Actions summary; the IPA, temporary signing
keychain, installed job-owned profile and API-key files are removed, not exposed
as public release assets. Existing unsigned iOS downloads remain unchanged.

### Public iOS App Store prerequisites

Ordinary published GitHub releases still upload only internal TestFlight
builds. The separate, manually triggered **Publish latest iOS release to App
Store** workflow uploads the latest stable versioned release, submits it to
App Review and requests automatic public release after Apple's approval.
It never creates a GitHub release or bypasses Apple's review.
See [App Review preparation](app-store-review.md) for the privacy-policy
publication, local demonstration, review notes, and remaining readiness gates.

Public App Store builds use only the frontend packaged in the signed app.
They do not check or download Pages frontend updates, restore downloaded
snapshots, or read saved frontend channel choices. The frontend Settings bundle
is excluded. The public distribution path embeds this policy in native bundle
metadata and verifies it, together with the absence of the Settings bundle,
in both the archive and extracted IPA before upload. Ordinary internal
TestFlight builds retain their existing frontend updates and Settings toggle.
This distinction is independent of their shared Release configuration.

Run it from the default branch only after the tooling has been merged and a
normal versioned release containing the bundled-only App Store policy has been
published. The workflow rejects older release sources before building or
uploading. It pins that latest release's exact tag and commit, excludes
prereleases and the rolling
`latest` channel, and shares the existing iOS upload queue. It builds Release
arm64 with an unused build number, verifies the archive and extracted IPA,
and requires Apple's `VALID` / `APP_STORE_ELIGIBLE` processing result.

Configure separate `CLANKY_APP_STORE_KEY_P8`, `CLANKY_APP_STORE_KEY_ID` and
`CLANKY_APP_STORE_ISSUER_ID` secrets for a team App Store Connect key with
App Manager permissions. These do not replace the existing notary/internal
TestFlight credentials. The workflow reuses the existing iOS Distribution
certificate/password and App Store Connect provisioning profile secrets.
No internal beta group or testers are required for this public export.

The [normal release task](development.md#creating-a-github-release) asks for
customer-facing App Store **What's New** and preserves it in a dedicated section
of that release's notes. The public workflow passes the exact selected release's
notes as data, not shell code.

Before building, the workflow reuses an editable App Store draft matching the
release number. Prepared copy and media are preserved; missing primary-language
What's New is filled from the release's dedicated section. If no draft exists,
it creates the matching iOS version using Apple's current-version metadata
inheritance, copies copyright and sets the new What's New from that release.
Another pending version or active review blocks preparation rather than being
renamed, overwritten or submitted accidentally. The first App Store version
must still be prepared manually because there is no distributed listing to inherit.

Inherited metadata must pass the same preflight as a prepared draft: copyright,
primary-language description/keywords/support URL, release notes for updates,
review details and completed iPhone/iPad screenshots. Missing inherited data or
missing release-specific What's New fails explicitly before upload. The workflow
does not invent text, upload replacement media, or change privacy/account/legal
information. Review inherited content and update screenshots or reviewer access
in App Store Connect when the shipping behavior changes. Apple additionally
validates exact screenshot specifications, other locales, privacy, agreements
and other submission requirements.

After processing, the workflow rechecks readiness without creating versions or
refilling fields, selects the verified build,
changes that version to **automatic release after approval**, and submits only
that app version using the review-submissions API. Existing active iOS review
submissions block it before upload; it never includes unrelated review items.
The Actions summary records submission, not approval or actual availability.
Apple handles publication after approval; no runner waits for the review.

Uploads and submission mutations are never retried automatically. If a run
fails or its outcome is uncertain, inspect the recorded build/submission in
App Store Connect before rerunning. Existing pending reviews must be resolved
there first. No upload or publication is needed merely to validate the tooling.

The native shell includes `PrivacyInfo.xcprivacy`, declaring its own-container
UserDefaults use with reason `CA92.1`. Xcode includes the shared resource;
Linux builds explicitly package it. The existing iOS resource verifier checks
the exact manifest and frontend update policy in built, archived, and exported
apps. Update-enabled builds must contain the checked-out Settings bundle;
public App Store builds must omit it.
Reassess the declaration when native APIs or data handling change.

The same valid Apple Distribution certificate **and private key**, matching
[App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)
and app record used for internal TestFlight can support public iOS distribution.
Keep the existing Bundle ID/team; moving to App Store does not itself require
another certificate, profile or app record. An authorized Developer-role team
API key can continue uploading builds.

An [internal-only build](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)
cannot be submitted to external testers or customers. Export a new
`app-store-connect` IPA without `testFlightInternalTestingOnly=true` and upload
it with a new build number. Changing group membership or store metadata cannot
convert an existing internal-only upload. The default TestFlight path
enforces internal-only export and processing checks. Its explicit `--app-store`
path instead requires public eligibility and submits for automatic release;
never invoke that mode as a dry run.

[Submitting for App Review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
requires Account Holder, Admin or App Manager permissions. A Developer-role key
is sufficient for upload, not review submission. To automate submission, use
an authorized team API key with App Manager permissions rather than granting
unnecessary Admin access. An authorized user submitting manually through
App Store Connect needs no additional API key.

Before submitting, prepare:

- The [required app/version metadata](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties),
  supported-device screenshots, description, support URL, age rating and
  content-rights declarations.
- A privacy policy URL and accurate app privacy disclosures. Reassess privacy
  and encryption/export compliance for the actual shipping app; internal
  TestFlight acceptance does not establish public compliance or App Review
  approval.
- Review contact details, instructions and dedicated review access when sign-in
  or an external service is required. Do not provide personal or production
  credentials as review access.
- Pricing, availability and applicable agreements for the selected markets,
  with an active Developer Program membership. The Account Holder must accept
  required legal agreements; paid apps/In-App Purchases also require the
  applicable paid agreement, tax and banking setup.

Upload, Apple processing, App Review submission, approval and public release
are separate steps. Neither a successful GitHub release nor an accepted
TestFlight build guarantees App Store approval or publishes the app publicly.

### Apple credential lifecycle and recovery

Check certificate/profile expiry and API-key authorization before publication.
Renew or replace expired or revoked credentials, and regenerate profiles when
their certificate or authorized app
capabilities change. Update matching CI inputs together without replacing
unrelated Mac Developer ID identities or Ad Hoc/OTA profiles.

Keep a recoverable backup in encrypted storage or an approved secret manager:
signing certificates with their private keys and intermediate chains, exact
PKCS12 passwords, provisioning profiles, App Store Connect API private keys
and their key/issuer identifiers, and the mapping to CI inputs. A public
certificate alone cannot restore a signing identity. Verify recovery with an
isolated temporary keychain and remove temporary credential files afterward.
Keep secret values out of tracked files, logs and public artifacts; local
paths, hosts, account identifiers and backup locations belong only in private
configuration, as described in [local-only information](development.md#local-only-information).

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
Native commands default to Debug. To build an optimized Mac app explicitly:

```bash
bun run build:apple:macos --configuration Release
open dist/apple/build/Build/Products/Release/Clanky.app
```

`build:apple:ios` and `build:apple:ios:device` also accept
`--configuration Debug|Release`; their outputs use `Debug-` or `Release-`
followed by `iphonesimulator` or `iphoneos`. Configuration selection does not
add distribution signing. Asset-only and Linux cross-build commands retain
their existing behavior and do not accept this native Xcode option.

The embed step rejects an app architecture not supported by the prepared CLI.
Debug Run builds only the active Mac architecture, matching the bundled helper;
Release builds still require a helper supporting every requested architecture.
Replace/rebuild the whole app to update it; running CLI self-update against
the embedded helper would modify the signed bundle and is not an app updater.

### Automatic Mac app updates

Public Mac builds use [Sparkle 2](https://sparkle-project.org/) to replace the
complete app, including its frontend and bundled controller. Install the first
updater-enabled build manually; older app versions cannot acquire an updater
through their web UI or CLI self-update.

**Clanky > Check for Updates...** checks immediately. **Clanky > Settings...**
shows the installed distribution version, source revision,
update channel, and automatic-update preferences. The initial channel matches
the downloaded app; a saved **Stable/Latest** selection overrides it. Stable
checks every 24 hours and latest every hour. Automatic checks, downloads and
installation on normal quit are enabled by default and can be disabled.
Development builds do not start the updater.

An immediate installation/restart requires an explicit **Install and Restart**
action in Clanky's app menu/settings or Sparkle's update window. Once an
automatic download is ready, it waits for that action or normal Quit rather
than starting another update cycle. Ordinary downloads do not terminate the app or its
controller. Update-triggered termination uses the same graceful controller,
Tailscale and asset shutdown as ordinary Quit; a failed shutdown cancels
termination rather than replacing a running app. When an update is already
staged for installation, finish it by quitting before changing channels.
An aborted update clears its staged installation state so fresh checks and
channel changes are available again once the update cycle ends.
The update does not replace standalone CLIs, remote controllers, user data or
WebKit sessions.

Changing channels never installs an equal or lower native build number.
Switching from latest to stable may therefore wait for a future stable build,
even when its display version looks newer. All builds from the binary workflow
share a monotonic native sequence derived from its GitHub run number; rerunning
the same run does not create a new native version. Preserve that sequence if
the workflow is replaced or its counter is reset.

Mac feeds are separate from iOS frontend updates:

| Channel | Appcast |
| --- | --- |
| Stable | `https://pablozaiden.github.io/clanky/macos/stable/appcast.xml` |
| Latest | `https://pablozaiden.github.io/clanky/macos/latest/appcast.xml` |

Feeds and archive downloads are public HTTPS resources; installed apps need no
GitHub token. The existing Pages deploy assembles both feeds from completed
native publications, independently of frontend build versions. Native asset
publication requests a new Pages deployment after completion. Every Pages
deployment includes and verifies both appcasts; it does not overwrite them with
frontend-only content or regress a published native build number.

Latest deliberately has no archive retention. A new CLI publication may remove
an older Mac ZIP before a cached appcast or in-progress download finishes.
That update fails safely without changing the installed app; check again after
the next Mac publication. Network, signature, installation permission and
controller-shutdown failures are reported rather than treated as success.
Install and run the complete app from a writable location, not inside a ZIP or
read-only disk image. Local controller connections are interrupted when the
user explicitly quits/restarts the app.

#### Sparkle dependency and signing key

`native/Configuration/sparkle.json` pins the Sparkle version, upstream archive
SHA-256, public Ed25519 key and feed base URL. Mac build commands require
`curl`, download and verify that distribution, and prepare the framework and
generated Xcode configuration under `dist/apple/`. Xcode and Linux Mac builds
use the same distribution; iOS does not link Sparkle. Re-run the Mac build
preparation after changing the pin or public configuration.

Configure `CLANKY_SPARKLE_PRIVATE_KEY` as a protected repository secret containing
Sparkle's exported, base64-encoded private seed. This is separate from the
Developer ID and Apple notarization credentials. The app embeds only its public
key. `scripts/macos-appcast.ts` uses Sparkle's `generate_appcast` with deltas
disabled, signs the final notarized ZIP, and verifies its Ed25519 signature
against the configured public key before generating publication metadata.
Feeds are not additionally signed; archive signatures remain mandatory and are
checked before extraction.

Generate/export/import keys using Sparkle's `generate_keys` tool and a dedicated
Keychain account. Keep a verified private export in restricted, offline-backed-up
storage, separate from served files and source checkouts; record machine-specific
locations only in private guidance. Verify recovery by deriving the matching
public key before configuring CI. Never print the seed, include it in command
arguments, commit it, or upload it as an Actions/release artifact.
Restore the existing key when replacing a signing machine. With verification
before extraction enabled, Ed25519 key rotation requires Sparkle's documented
Developer ID signed-DMG recovery path; losing the private seed is not solved
by simply changing the public key in a new ZIP.

### App icons

Both Xcode targets use the checked-in `AppIcon` asset catalog for Clanky's
native app icon, including Finder/Dock on Mac and the iPhone/iPad Home Screen.
These native icons are separate from web favicon and manifest assets.
The Linux build packages the iOS PNG from that same catalog through xtool.
After changing `src/logo.png`, regenerate those native assets on macOS with
`swift scripts/generate-apple-icons.swift` and rebuild the apps. The generator
keeps transparent clearance for Mac and produces an opaque square for iOS,
which applies its own icon mask. It does not sign or launch apps.

### Windows and local controller

**Local Controller > Network Access...** selects **Local Only** (the default),
**Automatic Remote Access (Tailscale)** or **Direct HTTPS**. Remote access is
opt-in and remembered; merely installing Tailscale does not publish Clanky.
Apply explicitly restarts a running controller and warns about interrupted
connections. The existing asset listener remains local and is not another
controller.

Automatic access discovers the installed Tailscale CLI, connected node and
HTTPS hostname. Clanky configures its own controller's canonical public URL
and publishes the loopback HTTP backend through Tailscale Serve on HTTPS port
443. Tailscale supplies the publicly trusted certificate; no Clanky certificate
or browser trust installation is needed. The native client uses that canonical
HTTPS origin for authorization and API requests, while startup health checks
use the separate loopback endpoint. Consequently, this connection mode needs
Tailscale; choose Local Only to work without it.

Install and sign in to Tailscale separately. If Serve/HTTPS needs tailnet
consent, **Finish Tailscale Setup...** opens Tailscale's approval page and Clanky
continues once it is enabled. Initial owner setup prompts for a password
locally before publication. Existing owners first add a password in Account
Settings while using Local Only. Passkeys remain preferred on the resulting
hostname; a localhost passkey cannot sign in to its different Tailscale RP.
Tailscale identity headers never substitute for Clanky authentication.
The loopback-only backend trusts only Serve's overwritten protocol header for
Mesh transport checks, not client-supplied forwarded prefixes.

The menu shows publication status and **Copy Remote Link**, enabled only after
the public HTTPS health check succeeds. Disconnections make remote access
unavailable without exposing another listener or silently restarting work.
Use the copied URL as the API address in the iPhone app or
[static browser client](static-client.md). The controller keeps its API-only
mode with authentication pages; the full Mac frontend remains bundled locally.
The same hostname reconnects automatically; a hostname change while running
requires applying Network Access again. An occupied Serve port is reported
without replacing existing routes. Clanky never enables Funnel, resets Serve
globally, stops Tailscale or changes tailnet policy.

An owned foreground Serve session lasts only with the app/controller. Its
separate lifetime observer removes the publication when the controller exits
or the app is forcibly terminated; normal Stop/Quit waits for unpublication
before stopping the backend. Logs are `app-controller.log` and
`app-tailscale.log` in the private controller directory below.

Direct HTTPS optionally switches the same controller listener to HTTPS at a
fixed LAN/Tailscale IP or network hostname on port `49372`. It binds all
interfaces and requires explicit browser certificate trust. Local Only remains
loopback HTTP with no certificate setup. Explicit Direct HTTPS settings are
not replaced simply because Tailscale becomes available.
Switching modes updates an automatically managed Mesh endpoint to the new
HTTPS origin, or clears it for Local Only. An explicitly configured Mesh
endpoint is preserved, including when it matches the previous managed address.

**Initialize Owner Password...** uses the bundled local CLI and private stdin
to create the first owner only. Existing accounts create/change their password
through authenticated Account settings before enabling managed access.
**Export Controller Certificate...** saves the public PEM, never the private
key. The TLS identity is durable in the controller's private data directory;
CLI rotation/recovery is described in the
[deployment guide](deployment.md#optional-controller-managed-https).

The Mac app loads its own known certificate for scoped native health and
WebView HTTPS trust challenges; unrelated origins retain normal OS validation.
External Safari/system-browser authorization does not inherit that trust:
install the exported certificate explicitly for that browser. iPhone/iPad
pairing/pinning is unchanged and is not supplied automatically by Mac trust.
Endpoint changes update the existing asset bootstrap and reload only pages
connected to the local controller, not unrelated remote windows.

**File > New Window** (`Cmd+N`) opens another native window. The window has no
extra title or navigation toolbar; the standard macOS window controls remain.
Windows share ordinary WebKit website data, just as browser tabs do. There
is no new native profile system. An invited pairing still supports only one
owning document at a time; close its other window before reconnecting.

The macOS menu bar's **Local Controller > Start Local Controller** starts the
bundled existing CLI with `serve --api-only true`, then connects the API client
to it after its health check succeeds. **Connect to Local Controller** connects
the active window to the running controller. Commands require an active Clanky window and are disabled
while the controller starts or stops. It is optional and stays off on a fresh
installation. Local mode always uses the app-owned controller's current endpoint,
not a previously selected API server, including after signing out or changing
Network Access. **Change server** opens the separate API connection mode; its
saved server and session remain independent of local mode.
A successful **Start Local Controller** is remembered: the next
app launch starts it automatically after the bundled UI is ready. Opening
another window or returning to the app does not start another process.
The first window waits for remembered controller startup to finish before
loading a connection page. When the app-owned controller is ready, each new
window connects to it by default, instead of restoring another connection mode.
This does not redirect an already-open window after you choose a remote API,
collaboration or the connection chooser. If the controller is off or fails to
start, windows retain the saved mode/chooser behavior and startup errors remain
visible.
Automatic startup uses the same health check and visible errors as manual
startup, without adopting an unrelated controller or repeatedly retrying.
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

**Stop Local Controller** stops the app-owned process and disables automatic
startup; connected local windows then lose their API connection. Quitting the
app requests normal CLI shutdown and waits for cleanup, but preserves the
saved startup choice. If shutdown does not finish, quitting is cancelled and
an error remains visible; the app does not silently abandon its controller.
The app continues observing that process after an interrupted or timed-out
shutdown. If it exits later, the controller state and log handle are finalized
and starting it again becomes available.
Closing a window is not quitting the app. A forced OS termination cannot run
normal GUI cleanup; an active Tailscale lifetime observer still withdraws its
owned publication and requests controller shutdown. Local-only controllers
have no such publication observer.

Bundling Clanky removes the need to install its runtime, not the workspace's
own tools. Local Git/provider execution still requires the tools,
authentication and execution-host configuration described in
[harness adapters](harnesses.md). Remote hosts retain their existing
requirements. The app does not install agents, Git or Devbox.

### Build on Linux; sign and package on a Mac

With the same Swift/xtool tools and private Darwin SDK used by the
[iOS Linux workflow](#compile-on-linux-simulate-or-sign-and-install-on-a-mac):

```bash
bun run build:apple:macos:linux
```

The output is `dist/apple/macos-linux/Clanky.app`, containing the arm64 Swift
shell, bundled web UI, native icon and arm64 standalone controller. It targets
macOS 14+ and Apple Silicon, not Intel or a universal app. Identity, versions,
language mode and deployment target come from the authoritative Xcode settings.
The installed app requires neither Bun nor a separate CLI installation.

The Mac path uses `swiftc` with xtool's SDK, its explicit `ld64.lld` path and
Apple's macOS Clang runtime. SwiftPM does not currently resolve the generated
SDK's `macosx` platform, and selecting Swift's host linker instead of xtool's
linker fails. Do not edit the installed SDK metadata or omit availability
runtime checks to work around that. The xtool linker currently emits
experimental-platform warnings for macOS; they remain visible. Successful
compilation does not establish runtime compatibility.

[`scripts/macos-app.py`](../scripts/macos-app.py), exposed as `bun run macos:app`,
provides the artifact-only signing workflow. It requires Python 3.9+ standard
library, the Linux build tools and the Mac's existing signing tools. Keep
environment values in a private parameter JSON outside the checkout, using
[`macos-app.example.json`](../scripts/macos-app.example.json) as its shape.
All configured paths must be absolute and traversal-free; symlink checks run
only on their owning host. The artifact directory belongs to Linux; the remote
artifact directory and Xcode directory belong to the Mac.
Select an existing, currently usable code-signing identity; account setup,
certificate creation and keychain permission remain explicit user/OS gates.
This private workflow does not promise Developer ID distribution or notarization.

From a clean source revision, choose a fresh direct child of the configured
Linux `artifactDirectory` as `RUN`:

```bash
bun run macos:app requests --config "$PARAMETERS" --work "$RUN" --stage preflight
bun run macos:app prepare --config "$PARAMETERS" --work "$RUN"
bun run macos:app requests --config "$PARAMETERS" --work "$RUN" --stage sign
bun run macos:app requests --config "$PARAMETERS" --work "$RUN" --stage download
bun run macos:app verify --config "$PARAMETERS" --work "$RUN"
```

Each `requests` invocation generates an ordered `steps` array and the exact
operations to describe before executing through the authenticated
[native file transport](control-chats.md#what-the-agent-can-do). Complete every
stage, including its receipt download, before proceeding. Stop on failure,
pending confirmation or uncertain outcome; do not replay a mutation.
`requests --stage status` generates a fresh inspection receipt after an
interruption without repeating signing. Frozen parameters and driver bytes
cannot change within a run.

`preflight` verifies the selected Apple Silicon Mac and signing identity.
`prepare` runs the application build, E2E and full macOS build entirely on Linux,
then records the clean source revision, bundle/platform metadata and transfer
digest. Only the standalone driver, private parameters, metadata and app archive
go to the Mac, never Swift sources, a Clanky checkout or Bun dependencies.
`sign` verifies the transferred app and signs the embedded controller before
the outer bundle, verifies both identities and packages the complete app.
`download` retrieves the ZIP in bounded byte ranges pinned to the signed
archive's ETag, avoiding an unbounded Mesh read. `verify` assembles
`Clanky-macos-arm64.zip`, checks its full digest, bundle metadata, executable
permissions and both arm64 macOS binaries, then writes its `.sha256` file.
No final ZIP is published locally until its complete digest and bundle pass.
Receipts and artifacts remain in the private run
directories; the driver does not install, launch or delete applications.

Extract the complete ZIP and copy the app to the intended Mac location.
Keep the same app identity and replace the whole bundle to preserve existing
preferences and WebKit data; do not uninstall or modify the embedded controller
in place. This workflow does not start the controller, change the iOS installer,
create a download service, publish a release or implement automatic updates.
Gatekeeper may still reject a privately signed, unnotarized download.
`verified.json` confirms artifact delivery, not launch, UI behavior or notarization.
Validate execution separately on a compatible Mac using isolated app data.

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

For an unsigned physical-device build on a Mac instead of the simulator:

```bash
bun run build:apple:ios:device
```

The output is `dist/apple/build/Build/Products/Debug-iphoneos/Clanky.app`.
It targets arm64 iPhones/iPads and explicitly disables signing; it still needs
the appropriate signing/provisioning and packaging before installation.
The existing `build:apple:ios` simulator command is unchanged.

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

For registered Clanky hosts, use authenticated native binary-file operations:
`bodyFile` supplies streamed raw archive bytes and `responseFile` receives
downloads on the originating execution host. See the canonical
[native file transport](control-chats.md#what-the-agent-can-do). The private
OTA tooling below generates the exact transfer and execution requests; discover
their live schemas before executing them. The file explorer remains an option
for human transfers. Do not encode binaries in JSON, extract CLI credentials
or invent an API-key bridge. A different transport requires its own approval.

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

For manual recording automation, `scripts/ios-simulator-ui.py` inspects Device
Hub's accessibility tree and supplies guarded presses, clicks and keyboard input
using macOS frameworks and Python's standard library. Run its `--help` on the
Mac; it requires existing Accessibility/input-event permissions and never grants
them. Inspection writes a new JSON file; presses require the inspected path and
current label, and coordinate clicks stay inside Device Hub windows. Select and
verify an isolated recording device before sending input. Typing sends individual
printable ASCII keystrokes and expects a US keyboard layout in the simulator.
Wait for focus and keyboard transitions before typing. Click controls once;
a follow-up Return can activate a replacement action.
Long terminal input has been unreliable in manual capture; use short commands
and verify the line before submitting.
Use `type --stdin` with private piped input for credentials, never command
arguments. Capture the selected simulator display with `simctl`, not the Mac
desktop, and keep original footage and edit artifacts private unless publication
is separately authorized.

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

## Scripted private iOS OTA builds

The complete repeatable implementation is
[`scripts/ios-ota.py`](../scripts/ios-ota.py), exposed as `bun run ios:ota`.
It uses Python 3.9+ standard library plus the existing Linux build tools and
macOS signing tools. Only this standalone driver, parameter JSON and built
artifacts go to the Mac, never the application checkout or Bun dependencies.
Keep environment values in a private parameter file outside the repository,
using [`ios-ota.example.json`](../scripts/ios-ota.example.json) as the shape.
The [personal guidance](development.md#local-only-information) supplies its
location. It contains values only, not commands or copies of this implementation.

The driver owns version selection, validation, archive hashing, exact
Ad Hoc identity/profile/device checks, signing, IPA layout, HTTPS/bootstrap
hosting, trust-profile and installer generation, atomic publication, rollback
and full trusted-download verification. The existing app identity, profile,
signing key and trusted root are reused. It supports integer native build
numbers from 1 through 9999; the next number exceeds both the source project's
number and the currently published number. No project edit or GitHub release
is needed for a distribution-only build increment.

From a clean source revision, choose a fresh direct child of the configured
Linux `artifactDirectory` as `RUN`. These are script entrypoints, not commands
to reconstruct on the signing host:

```bash
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage preflight
bun run ios:ota prepare --config "$PARAMETERS" --work "$RUN"
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage sign
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage publish
bun run ios:ota verify --config "$PARAMETERS" --work "$RUN"
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage cleanup
bun run ios:ota cleanup --config "$PARAMETERS" --work "$RUN" --confirm cleanup
```

Each `requests` invocation produces an ordered `steps` array and a
`describeBeforeExecution` operation list. An authorized native agent describes
those operations and submits the generated inputs unchanged, stopping on
failure, pending confirmation or uncertain outcome. Complete each stage's
transfers/execution/receipt download before running the next entrypoint.
The native tools provide authority, confirmations and transport; the scripts
provide all build/deployment logic. No model-generated remote signing code,
extra CLI credentials or new control transport is required.

`preflight` verifies the selected Mac's signing material and live installer.
`prepare` runs the required application build/E2E and physical-device xtool
build entirely on Linux, stages the incremented bundle metadata and records
the exact clean revision and transfer digest. `sign` verifies the current
publication has not changed and signs that artifact on macOS. `publish`
preserves immutable previous releases and selects one complete new release
with a single atomic pointer replacement; manifest links pin the exact IPA,
so clients cannot mix generations. `verify` pins the configured root digest
before trusting it, downloads the whole signed IPA over verified HTTPS and
compares its bytes, bundle metadata, manifest and installer link.
`verified.json` contains the installation URL, not a claim that the phone
installed it. Open that URL in Safari on the private network/VPN and install
over the existing app without uninstalling or clearing its data.
For ordinary private Ad Hoc deployment, finish with the configured installation
page serving the verified build and return that page's URL. Signing alone or
leaving a loose IPA is not a completed deployment. Stop at an unpublished
signed artifact only when explicitly requested.

### Explicit installer administration

These are separate, confirmed stages of the same script, not side effects of
an ordinary build:

| `requests --stage` | Effect |
| --- | --- |
| `setup` | Install/reuse the managed Mac-user HTTPS service, retaining the pinned CA and importing an existing legacy installer without changing its IPA. Required when preflight says `needsSetup`. |
| `setup --initialize-ca` | First setup only: create a 10-year private root and one-year HTTPS leaf. Requires an empty TLS directory and null root fingerprint. Pin the returned fingerprint in private parameters and start a fresh run before building. |
| `renew-tls` | Renew the one-year HTTPS leaf with the existing Mac-local CA key and restart only this installer service. Does not replace the trust root. |
| `rollback` | Restore the previous immutable release from this run, refusing a stale rollback if another publication has since become current. |
| `status` | Inspect current publication, service and run files after an interruption. Never automatically replay an uncertain mutation. |
| `reconcile` | Recover a missing publication receipt or validate an existing remote receipt for download, only when the current immutable release exactly matches this run's signed artifact/revision. Does not publish or replay anything. |
| `stop` | Stop the configured installer service, retaining certificates and published data. |

Setup records its previous launch configuration and restores it if startup
fails. It requires the existing provisioning identity/profile; obtaining Apple
accounts, licensed SDKs or keychain permission remains an explicit OS/user
gate, not something a script fabricates or bypasses. New trust requires
installing the public certificate profile and enabling full trust on iOS;
clicking through a Safari warning is insufficient for OTA installation.
Private keys remain outside served files on the Mac. Ordinary updates never
rotate certificates, change signing identity, install on the phone or deploy
the Clanky API server. Inspect expiry/signing errors rather than creating
replacement material without approval.

Run directories retain parameter snapshots and JSON receipts for inspection.
Cleanup removes only known temporary build/sign/download files, never the run
root, published releases, rollback data, CA or signing material. No part of this
workflow depends on another chat's session directory or one-off scripts.

### Deploy an existing CI build

The unsigned `apple-app-ios-arm64` Actions artifact can replace local compilation.
Download it into a private directory outside the checkout and select its exact
expected source revision. After completing the ordinary `preflight` requests,
prepare the downloaded artifact instead of rebuilding:

```bash
bun run ios:ota prepare --config "$PARAMETERS" --work "$RUN" \
  --ci-artifact "$CI_ARTIFACT_DIRECTORY" --source-revision "$EXPECTED_REVISION"
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage sign
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage publish
bun run ios:ota verify --config "$PARAMETERS" --work "$RUN"
```

Complete each generated request stage before continuing. Preparation verifies
the CI source/target metadata, archive checksum and device bundle identity,
retains the original provenance, and increments the native distribution build
number using the existing publication baseline. It does not compile application
sources. The signing stage still verifies the physical-device executable,
provisioning profile, certificate and final signature on the Mac.
If preflight reports `needsSetup`, obtain approval for the existing `setup`
stage and complete it before publication. Updating the installer driver restarts
only that service and retains its pinned trust root and previous release.

When an unpublished signed IPA is explicitly requested, replace publication
and trusted installer verification with:

```bash
bun run ios:ota requests --config "$PARAMETERS" --work "$RUN" --stage download
bun run ios:ota verify --config "$PARAMETERS" --work "$RUN" --signed-only
```

`download` retrieves the signed IPA without publishing it. `--signed-only`
checks its complete bytes and bundle metadata against the signing receipt and
writes `verified-signed.json` with its private path. This leaves the existing
installer and devices unchanged; ordinary publication remains a confirmed
stage. Retain unpublished signing runs for subsequent deployment;
the publication-only cleanup gates remain unchanged.

## Connections and web behavior

On first use, choose **Connect to an API** or **Connect through collaboration**.
Reopening the app or creating a window goes directly to the last selected mode,
including an unfinished connection/login flow. Existing web storage resumes the
API session or invited connections; Swift persists the mode, not remote
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
The optional Mac local-controller connection mode is separate from the saved
controller launch preference. Restoring that mode alone does not start a server;
a successful **Start Local Controller** enables automatic startup on later app
launches. **Stop Local Controller** disables automatic startup, while quitting
preserves the choice. On Mac, a healthy app-owned controller takes precedence
over the saved connection mode when opening a new window, after startup has
settled. Existing windows keep explicit connection choices.
See [Windows and local controller](#windows-and-local-controller).
Ordinary static-site/browser startup is unchanged.

API login
uses the existing device-authorization flow: the shell opens the system browser,
you authenticate on the controller's origin with a passkey, password or API key,
and the existing client completes authorization. Passkeys are not requested for the
bundled UI's local origin. Remote APIs require HTTPS; loopback development
APIs may use HTTP.

For collaboration, choose the owner's `.clanky-invite.json` file in the existing
web form. Validation, pairing, grants and Direct/Relay routing are unchanged.
See [static clients](static-client.md#browser-only-collaboration) for their
capabilities and limitations.

All UI assets, including fonts, Monaco and its workers, are bundled. In
update-enabled iOS builds, a verified downloaded frontend can replace that
bundled UI as described below. Public App Store builds remain bundle-only.
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

The shell checks the listener through an uncached, instance-specific local HTTP
response when a scene becomes active and before native page loads or reloads.
A stopped listener is restarted automatically at the same origin using the same
frontend snapshot, without discarding the current WebView or asking for retry
during successful recovery. An interrupted local navigation is retried once
after checking readiness; already loaded healthy pages are not reloaded.
Listener failures recover immediately while a scene is active and otherwise
wait for foreground activation. Concurrent windows share one recovery operation.
Startup and HTTP checks have bounded waits. Two rapid restarts exhaust automatic
recovery; a later independent failure gets a fresh allowance after ten seconds
without a restart, without requiring the app to be backgrounded. Exhausted
recovery or an occupied saved port shows an informational error; there is no
manual retry. Failed local loads retry automatically on the next activation.
This does not replay remote API operations or recover a lost authenticated
session, and it does not provide background execution.

The shared web frontend also recovers failed workspace images and the web
sidebar logo after temporary loading errors, without reloading the page.
Healthy images are left alone. See [icon loading recovery](workspace-icons.md)
for the bounded retry behavior; it does not bypass authentication or change
the native listener's recovery policy.

The iPhone sign-in screen includes local session diagnostics for intermittent
sign-outs. It retains at most ten structured restoration, renewal, removal,
foreground/background, and connectivity-hint events, with timestamps and
HTTP status categories. The history stays on the phone and contains no
credentials, authorization codes, API addresses, request/response bodies, or
user content. Expand **Session diagnostics** to inspect it after sign-in returns.
The last recorded credential-removal cause survives subsequent connectivity
events until a session is restored or the user signs out/changes servers.
Connectivity hints are not proof of server reachability, and diagnostic events
do not change authentication validity, renewal, or credential-removal policy.
Other clients do not record or display this history.

The same section also lists **App events** from a native iPhone history kept
outside WebKit storage, so it survives when website data is lost. It retains at
most twenty timestamped events: app start, web content termination, local server
stop/restart, and web storage found empty. Empty storage is detected with a
local marker written on first load; reporting it changes no behavior.

Credentials remain in the existing web client's persistent storage; invitation
private keys retain their existing nonextractable Web Crypto storage. As with
the browser client, trusted application JavaScript can access its own sessions.
API and app-local-controller credential operations share one native coordinator
across windows, separately for each installation origin and client storage
namespace. An unfinished operation remains owned when its page becomes inactive
or enters the back-forward cache, even if WebKit releases that page's Web Lock.
The next window receives the last confirmed saved credential snapshot before
continuing, so a stale localStorage cache cannot reuse the previous refresh token.
The coordinator keeps those snapshots only in process memory, not Keychain or
native preferences. Queued operations can be canceled without releasing the
active owner's operation. A departing uncached page or terminated web content
process fails its affected waiting requests visibly. The same applies if an
operation cannot confirm its saved snapshot; waiting windows must not receive an
obsolete cached token. A failed snapshot reconciliation or credential operation
releases ownership without publishing a snapshot, even if localStorage still
contains readable older credentials. The coordinator does not claim to recover a lost
token-exchange response. Genuine server revocation and replay rejection
remain unchanged.
Both the native shell and frontend must include this coordination. A frontend
update alone cannot add the native coordinator to an older installed app.
API, invitation and app-local-controller paths retain separate client storage
namespaces; paths are not security boundaries. Replacing the bundle preserves
website data for the same app identity. Clearing that data or changing the app
identity may lose sessions and pairings.

External top-level links open in the system browser. File selection uses WebKit's
native picker; downloads use the Mac save panel or iPhone/iPad export sheet.
The image preview dialog's **Download** action uses this same native flow with
the displayed image's bytes and filename: **Save As** on Mac, or the share sheet
on iPhone/iPad with the system's available sharing, copying and saving actions.
Cancelling either dialog leaves the preview open and does not report a save.

In the Mac, iPhone and iPad apps, STT and Live Voice use the app's normal system
microphone permission without additional website permission dialogs for
`127.0.0.1`. This applies to API, collaboration and Mac local-controller
connections. The native shell authorizes only microphone capture from its
current main WebView's main frame at the installation's exact saved frontend
origin after checking the app's native recording permission. Denied or revoked
permission rejects capture rather than starting a silent recording. Popups,
embedded frames, other origins, camera capture and combined camera/microphone
requests are not authorized by this policy. The system permission dialog and
privacy indicators still apply.
On iPhone/iPad, camera attachments continue to use the native file picker.
This native permission policy requires an updated app binary; downloaded
frontend updates cannot change it. Ordinary browser permission behavior is
unchanged.

API resource downloads use the framework's explicit native-save handoff after
the existing selected-server validation and ticket acquisition. The native host
checks the calling main-frame API or Mac local-controller frontend document,
including its directory root, against the saved local origin. It allows HTTPS
destinations or loopback HTTP without receiving API bearer credentials.
Acceptance starts WebKit's download flow; it does not mean that a file has
already been saved.
Content popups such as **Open image in a new tab** appear in a closable in-app
sheet. Authorization popups still hand their external URL to the system browser
and dismiss the temporary sheet.
Validate native bridge payloads before Foundation `JSONSerialization`; scalar
roots can raise an Objective-C exception rather than a catchable Swift error.
The invited client's **Ready to export** still means browser storage, not a
confirmed save to Files/Downloads. Platform storage/export limits still apply.

There is no background execution, background transfer or offline synchronization.
On iPhone/iPad, keep the app in the foreground for active transfers; suspension
may interrupt connections. If WebKit terminates the main page, the shell
reloads the same WebView automatically after confirming the local server, or on
the next activation if the app is inactive. The WebView is never replaced.

### Frontend updates on iPhone and iPad

Public App Store builds are bundle-only: the frontend changes only when the
app itself is updated. They never check or download frontend updates from
Pages and do not expose the frontend channel setting. Previously saved
channels and downloaded snapshots are ignored, not deleted; connection
settings, sessions and local UI recovery are unchanged.

The update behavior below applies to ordinary internal TestFlight, local
and unsigned iOS builds.

In **iOS Settings > Apps > Clanky**, **Use latest frontend** chooses the
frontend update channel. The toggle is off by default for every update-enabled
iOS build, including main, local, prerelease and TestFlight builds:

| Setting | Update metadata |
| --- | --- |
| Off: stable (default) | `https://pablozaiden.github.io/clanky/stable/build-info.json` |
| On: latest | `https://pablozaiden.github.io/clanky/latest/build-info.json` |

The preference is stored by iOS, independently of native build origin,
Debug/Release configuration and frontend version. The same Settings bundle
is packaged and verified in Xcode, Linux/xtool, CI and signed/exported TestFlight
apps. It requires an updated native shell; a Pages frontend update cannot add
the system setting to an older installed app.
Saved snapshots and selections are kept separately for each channel.
Invalid saved preference data is reported explicitly.
The old root update URL is not retained; older app builds need replacement.

Before opening the WebView on a cold launch, the app checks the selected channel.
Changing the toggle takes effect on returning to Clanky, without force-quitting.
It always requests that channel's metadata and applies its verified frontend,
even for an older version or the same source revision. This explicit choice is
automatic, including from a development frontend. An already cached target is
verified and reused, not accepted without checking its public metadata.
There is no downloading while Settings has suspended Clanky; only the final
selection is observed when returning. If preparation fails, the running frontend
stays selected and an informational warning is shown; the pending switch is
retried on a later activation. Concurrent scenes share one update operation;
every scene activation checks the preference. Obsolete checks and their
development prompts are cancelled.

An unchanged frontend manifest digest needs no asset download, installation
or confirmation during ordinary updates.
A published frontend also skips rebuilds of its already installed source
revision when the stable release version has not advanced, even if bundler
details or the latest/main version timestamp change. A newer stable release
version updates even at the same source revision; an old saved release cannot
block that upgrade merely because the commit matches.
Development frontends do not use that shortcut because they may include
uncommitted changes. `builtAt` alone never triggers an update. With an unchanged
channel and no pending switch, returning from the background, reloading the
web page, opening another scene and retrying the local asset server do not
initiate another update check in that process.

When a different frontend is available, the app prepares it during that same
startup and opens the updated UI. The version used to detect development
builds is the frontend version shown in the sidebar, not the backend or native
bundle version. By default it originates in `package.json.version`, is passed
through `CLANKY_VERSION`, and is embedded in each mode's `webapp-client.json` and the
site's build metadata. The checked-in `0.0.0-development` version retains its
`-development` marker in default local builds; Pages CI resolves a published
version before packaging, and TestFlight passes its release version explicitly.
Apple asset/native builds can set `--frontend-version` without changing the
package version; this build parameter does not select or change update channels.
During an ordinary non-switch update, an active version with the development marker offers
**Update** or **Keep Current** before downloading the update. Keeping it asks
again on a later cold launch if a different deployment is still available.
Once the active frontend is a published version, updates are automatic.
Xcode's Debug configuration is not the development-build confirmation
criterion either; a local development frontend still asks before its first
channel update.

Downloads use the existing Pages assets and their manifest's byte sizes and
SHA-256 hashes. Identical verified local assets are reused, including assets
shared between connection modes. The complete snapshot is prepared in private
Application Support storage and selected atomically, never written into the
signed app bundle. The active snapshot stays fixed unless the user changes
channels. The target is prepared before the existing listener switches roots
at the same origin; the existing WebViews reload without replacing their
persistent website data stores. Unsaved in-memory page state can be lost on
that deliberate reload.
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
