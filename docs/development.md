# Development

Clanky is a Bun application with an embedded server, React UI, CLI, and
standalone build. This is the entry point for contributors; technical policies
have one canonical guide rather than copies in `AGENTS.md`.

## Repository language

Use English for all repository-authored source, comments, documentation and
user-facing text, including generated pages and operation confirmations.
Preserve user-provided content, private parameter values and intentional
language support.

## Set up a source checkout

```bash
git clone https://github.com/pablozaiden/clanky.git
cd clanky
bun install
bun run dev
```

The combined development server runs `bun --hot src/index.ts serve` at
<http://localhost:3000>. Use Bun tooling, not a separate frontend development
server or `CLANKY_WEB_DIST_DIR`. Use a disposable `CLANKY_DATA_DIR` for local
experiments so developer/production data is not modified.

## Local-only information

Keep personal, environment-specific, or otherwise non-shareable local guidance
in `$HOME/.clanky-personal-guidance.md`, outside repository checkouts. Read it
when present at the start of work and before environment-specific actions,
using only the notes relevant to the current repository and execution host.

Create or update that file when recording verified local facts, preserving
unrelated notes. Keep it private to the user and identify which repository or
host each note applies to. All checkouts and worktrees using the same user home
share this one file; do not keep separate worktree copies.

Personal guidance and private configuration contain parameters only: selected
hosts, paths, network addresses and signing identifiers. No commands, procedures,
embedded scripts or task history belong there. Implement repeatable build,
signing, transfer and deployment processes as versioned repository scripts;
shared guides document their entrypoints, prerequisites and safety policies,
not a second hand-maintained implementation. Scripts must accept private values
as parameters rather than hard-coding them or depending on files from a previous
chat. Remove obsolete observations and duplicated procedures.

Never commit or publish the file, copy private details into tracked files, or
link to private notes from shared documentation. Keep tracked guides, examples
and configuration reusable, using placeholders instead of personal values.
Keep binary artifacts and private source patches outside repository checkouts,
separate from the Markdown guidance.

Personal guidance is not a secret manager. Keep passwords, tokens and private
keys in approved secret storage, not documentation or personal notes.

## Choose a development guide

Read the guide relevant to the change, not every guide for every task.

| Work | Canonical guide |
| --- | --- |
| Layers, authorization, execution hosts, backends, persistence, realtime, or concurrency | [Architecture and domain boundaries](development/architecture.md) |
| Coverage decisions, E2E boundaries, fixtures, timeouts, cleanup, or visual validation | [Testing and validation](development/testing.md) |
| UI, settings, routing, framework ownership, or upstream webapp changes | [UI and webapp development](development/webapp.md) |
| Breaking Mesh wire changes | [Protocol evolution](mesh-worker.md#protocol-evolution) |
| Docker, proxy, authentication, production access, or database reset | [Deployment and configuration](deployment.md) |
| Apple app builds, signing, simulation, or device deployment | [Apple apps](apple-apps.md) |
| Provider selection and runtime behavior | [Harness adapters](harnesses.md) |

Keep documentation about behavior, constraints, and their rationale. Types,
method signatures, helper catalogs, and implementation details already clear
in code do not need a parallel prose reference. Document feature changes in
the appropriate guide and update applicable skills. Keep the root README a
short introduction, installation/quick-start guide, and navigation entry point.

## Build and test

For application changes:

```bash
bun run build && bun run test
```

The build produces the standalone `dist/clanky` and relocatable `dist/client/`.
`bun run build:client` builds just the frontend;
`CLANKY_CLIENT_API_URL` can supply its initial API default. See
[Static frontend and remote API](static-client.md) for separate hosting and
`serve --api-only`.

The optional [Apple app shell](apple-apps.md) packages the same frontend in
Swift + WKWebView for macOS and iPhone/iPad. Use `bun run build:apple:macos`
for a Mac `.app` including the existing standalone CLI/controller, or
`bun run build:apple:ios` for the client-only iOS simulator app.
`bun run build:apple:ios:device` builds the unsigned physical-device app on a Mac.
The nightly/manual main and versioned-release workflow builds both Mac and iOS
device apps on hosted Mac runners, saving app archives, checksums and source
metadata as Actions artifacts
and attaching versioned copies to the rolling `latest` and published versioned
releases after the CLI publisher succeeds. Both channels sign and notarize the
Mac app, bundled controller and standalone Darwin binaries with one Developer
ID Application identity. The iOS device archive remains unsigned.
Release artifact downloads fail on a digest mismatch instead of publishing
unverified assets.
Native Apple builds use Debug for main and Release for published versioned
releases; manual native commands default to Debug and accept
`--configuration Release`.
The four Linux/macOS CLI binaries also compile on that Mac runner image using
their existing Bun targets; main and versioned releases share this arrangement.
`bun run build:apple:ios:linux` cross-compiles the physical-device app on Linux;
`bun run build:apple:ios:simulator:linux` builds for Apple Silicon simulators.
`bun run build:apple:macos:linux` cross-compiles the Apple Silicon Mac app,
including its controller; `bun run macos:app` stages private signing and packaging.
These optional Linux builds use Swift and xtool; simulation, signing and wireless
installation can remain on a Mac without installing Clanky's source or
dependencies there.
See the Apple guide for the SDK and device setup.

Use the [testing guide](development/testing.md) for prerequisites, narrower
checks, coverage decisions, and required validation.

## Dependency updates

Update registry packages and their transitive resolutions with
`bun update --latest --exact`, then commit `package.json` and `bun.lock`
together. Bun normally enforces the three-day minimum release age in
`bunfig.toml`. An explicitly approved update to freshly published stable
versions can use `--minimum-release-age 0` for that command only; keep the
repository safeguard unchanged.

Clanky uses Bun's isolated linker to share one instance of each dependency
version, including stateful ASN.1 schema registries. Keep directly imported
packages and required peers explicit rather than relying on hoisting.
Keep Clanky's X509 major aligned with SimpleWebAuthn's supported major:
different X509 majors register algorithms in the same process-global container
and cannot safely coexist. Do not force an unsupported transitive major.

Check GitHub-hosted packages against their latest stable release tags
separately. Keep CI actions pinned to the corresponding release commit SHAs
and refresh development-container feature versions and digests together in
`.devcontainer/devcontainer-lock.json`. Do not force transitive dependencies
outside their parents' supported ranges.

First-party webapp dependencies use the
[upstream integration workflow](development/webapp.md#upstream-framework-changes),
including development commit pins, coordinated merge timing, and final commit
verification.

## Pull request reviews

After opening a PR, wait for review comments before merging unless explicitly
instructed otherwise. Address every requested or suggested change by implementing
it or replying with a reason not to. Merge only after review has arrived and
all feedback has been addressed. This also applies to upstream integration PRs.

Review readiness alone does not authorize an upstream merge. For webapp changes
consumed by Clanky, also follow the
[coordinated merge timing](development/webapp.md#upstream-framework-changes).

## Creating a GitHub release

Install [GitHub CLI](https://cli.github.com/) and authenticate with
`gh auth login` using an account allowed to create releases in the repository.
Always use the release script, not manual tags or `gh release create`:

```bash
bun run release
```

Choose a `major`, `minor`, or `patch` increment. The script uses the highest
published stable `vX.Y.Z`
release as its baseline, ignoring drafts, prereleases, and other tag formats.
An existing stable release is required; local tags and the development version
in `package.json` are not used.

Enter an intentional, customer-facing App Store **What's New** in English
(1-4000 characters). The script previews it with the proposed tag/title and
remote default branch commit before confirmation. It stores the text in a
dedicated App Store section alongside GitHub-generated release notes, so the
separate iOS publication workflow can use it without copying the developer
changelog or stale notes from an earlier version. Preserve that section's
markers if editing the GitHub release notes later.

The script releases that exact remote commit, regardless of the local branch
or unpushed changes. Do not publish merely to validate the script.

Only typing `yes` at the final prompt publishes. Enter at the bump or What's
New prompt, EOF, or any other confirmation cancels without creating a tag or
release. The tag and title are identical `vX.Y.Z` strings, and existing remote
tags are rejected. Publication triggers binary and Docker release workflows;
it does not run public iOS submission.

Main merges do not publish distributions. A daily 03:00 `America/New_York`
publication updates the rolling `latest` binaries, signed apps, Docker images
and Pages when main has changed or a later publication attempt failed.
Manual execution forces generation from current main. Existing
version formats, tags and signing remain unchanged. See
[Binary installation and update channels](binary-updates.md).

## Release metadata

Release targets, binary artifacts, Docker platforms, and installer projections
are declared in `.github/release-metadata.json`. Check or regenerate the
generated installer metadata with:

```bash
bun run release:metadata:check
bun run release:metadata:generate
```

Edit the canonical release metadata, not the generated installer projection.
