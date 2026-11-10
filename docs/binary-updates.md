# Binary installation and update channels

Clanky binaries for Linux and macOS (x64/arm64) are distributed through
GitHub releases, not npm. Use WSL for a Linux environment.
The default installer selects the latest stable release:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/clanky
```

Opt in to the rolling build from main:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/clanky --channel latest
```

The CLI follows the installed channel:

```bash
clanky version
clanky update --check
clanky update
clanky update --channel latest
clanky update --channel stable
```

Stable builds stay on stable; versions containing `-main-` stay on latest.
An explicit channel switches tracks, including returning from a main build
to an older stable release. `--check --channel latest` checks that channel
without changing the installation. Channel selection cannot be combined with
`--version` or `--pre-release`; an exact `--version` remains available.

Workers can have a persistent default that takes precedence over version-based
inference. Read or set it with `clanky worker channel [stable|latest]`; this
does not immediately update the binary. With a saved worker default,
`update --channel ...` overrides the channel for that invocation, whereas
`worker channel ...` changes future default updates. Maintenance's
**Stable/Latest** applies both operations and restarts the worker only
after verification. **Default** preserves each worker's selection.
The same selector controls automatic workspace creation and Restart/Rebuild;
Restart/Rebuild always resolves and installs the current release of the selected
channel, then verifies that its full build version is running. This also applies
when the previous binary already used that channel. See
[Mesh worker maintenance](mesh-worker.md#update-servers-and-automatic-workspaces-together).

Main merges do not publish distributions. The **Build and Release Binaries**
workflow runs daily at 03:00 `America/New_York`, following Eastern daylight
saving changes. Scheduled runs skip only when the most recently completed main
publication attempt succeeded for the current main revision, including manual
runs. A later failed or partial attempt forces recovery on the next nightly
even if the revision is unchanged.
Use **Run workflow** on `main` to force a complete rolling publication even
without new commits, or run:

```bash
gh workflow run binary-release.yml --repo pablozaiden/clanky --ref main
```

The workflow builds the supported Linux and macOS targets from its selected main
revision, together with the existing Docker images and native apps. Final Pages
publication waits for Docker and native assets and verifies actual delivery.
Scheduled/manual main runs serialize; PR checks and explicit versioned releases
keep their existing triggers. The binary workflow identity and native build
counter are retained, and names, version formats and Docker tags do not change.
After all target builds succeed, the shared installer workflow replaces assets in
one prerelease tagged `latest`. A unique version and source revision identify
each build; `release.json` selects its binaries and checksum files. The workflow
skips superseded main commits, preserves macOS signing, and removes obsolete
rolling assets without deleting versioned releases.
After both CLI publication and native Apple builds succeed, the same release
also receives the Mac/iOS app archives, checksums and platform build metadata.
Their filenames use that release's exact version; rolling publication shares
the CLI publisher's lock and freshness checks. These app bundles are not inputs
to the CLI installer or updater. Public Mac apps instead use their own signed Sparkle
updates, with independent stable/latest feeds and native channel preferences.
They update the whole bundle on quit, not just the embedded binary. Latest Mac
archives have no retention; a stale/in-progress download may fail safely during
rolling publication. See [automatic Mac updates](apple-apps.md#automatic-mac-app-updates)
and [Apple downloads/signing](apple-apps.md#ci-builds-for-main-and-releases).

Stable and rolling binary builds share one Apple Silicon `xcode-27` compilation
job. It installs dependencies and runs prebuild once, then uses the same Bun
entrypoint to compile Linux and Darwin x64/arm64 targets in sequence. Only
Darwin binaries receive Developer ID Application signing with Hardened Runtime
and secure timestamps. On both channels, the two standalone architectures
share one Apple notarization submission after compilation; publication requires
accepted tickets covering their exact signed code hashes. Raw binary filenames
and checksums remain unchanged. Apple cannot staple tickets to standalone
executables, so those use online ticket lookup rather than an attached ticket.
They share the Mac app/controller's signing certificate; see
[CI signing setup](apple-apps.md#ci-signing-and-notarization).
The native Apple app job uses the same runner image separately. Metadata and
publication remain lightweight Linux jobs; Docker and native platform E2E
tests are unchanged.

GitHub's latest **stable** release endpoint is separate from the tag `latest`.
The CLI update channel does not add unattended updates or restart running servers.
Stop processes using the binary before updating when required by the platform,
then restart them to run the new build. If publication overlaps a download,
the operation can fail safely; rerun it after publication completes.
