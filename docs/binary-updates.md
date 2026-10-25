# Binary installation and update channels

Clanky binaries are distributed through GitHub releases, not npm.
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

On Windows, use the PowerShell installer with `-Channel latest`:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/pablozaiden/installer/main/install.ps1))) pablozaiden/clanky -Channel latest
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
see [Mesh worker maintenance](mesh-worker.md#update-servers-and-automatic-workspaces-together).

Every main push builds the supported Linux, macOS and Windows targets. After
all target builds succeed, the shared installer workflow replaces assets in
one prerelease tagged `latest`. A unique version and source revision identify
each build; `release.json` selects its binaries and checksum files. The workflow
skips superseded main commits, preserves macOS signing, and removes obsolete
rolling assets without deleting versioned releases.

GitHub's latest **stable** release endpoint is separate from the tag `latest`.
This channel does not add unattended updates or restart running servers.
Stop processes using the binary before updating when required by the platform,
then restart them to run the new build. If publication overlaps a download,
the operation can fail safely; rerun it after publication completes.
