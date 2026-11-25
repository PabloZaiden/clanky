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
server or `CLANKY_WEB_DIST_DIR`. Before starting it on a machine with an installed
Clanky, select a disposable home/configuration/data environment and an unused
loopback port, and clear inherited worker lifecycle metadata. Follow the
[isolation requirements](development/testing.md#isolation-synchronization-and-cleanup)
for development servers and manual experiments as well as tests; a disposable
`CLANKY_DATA_DIR` alone is not sufficient.

## Local-only information

Keep personal, environment-specific, or otherwise non-shareable local guidance
in `$HOME/.clanky-personal-guidance.md`, outside repository checkouts. Read it
when present at the start of work and before environment-specific actions,
using only the notes relevant to the current repository and task, including
configured remote development hosts.

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
| Layers, authorization, execution hosts, filesystem/Git, backends, persistence, realtime, or concurrency | [Architecture and domain boundaries](development/architecture.md) |
| Coverage decisions, E2E boundaries, fixtures, timeouts, cleanup, or visual validation | [Testing and validation](development/testing.md) |
| UI, settings, routing, framework ownership, or upstream webapp changes | [UI and webapp development](development/webapp.md) |
| Breaking Mesh wire changes | [Protocol evolution](mesh-worker.md#protocol-evolution) |
| Docker, proxy, authentication, production access, or database reset | [Deployment and configuration](deployment.md) |
| Apple app builds, signing, simulation, or device deployment | [Apple apps](apple-apps.md) |
| Provider selection and runtime behavior | [Harness adapters](harnesses.md) |
| Dependencies, PRs, or releases | [Dependency updates](#dependency-updates), [PR reviews](#pull-request-reviews), and [releases](#creating-a-github-release) |
| fframes video creation or review | [Video skill](../.agents/skills/fframes-video/SKILL.md) |

## Documentation policy

Before adding documentation, ask whether it helps someone perform supported
work or avoid a non-obvious pitfall. Keep current entrypoints, prerequisites,
workflows, meaningful constraints and necessary rationale. An implementation
change or visible UI adjustment alone does not justify more documentation.

Use definitions, callers, script help and API/schema discovery rather
than parallel references for types, signatures, schemas, route/helper catalogs,
constants or internal timing, caching and rendering mechanics.

Do not record task histories, migration chronology, discarded experiments or
obsolete features/workarounds. Preserve still-required upgrade, compatibility,
security and platform-specific constraints. Keep an active workaround only
while necessary, explaining its current scope and condition rather than the
history of attempts.

Update or remove affected text in its canonical guide instead of appending a
new narrative or duplicating it elsewhere. `AGENTS.md` owns agent workflow,
not shared technical policies. Apply the same usefulness and single-source
rules to skills, respecting their ownership.

Keep the root README a short introduction, installation/quick-start guide and
navigation entry point.

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
for a Mac `.app` with its controller, or `bun run build:apple:ios` for an iOS
simulator app. The Apple guide owns prerequisites, device and Linux builds,
signing, configuration selection and CI distribution.

Use `bun run build:linux:desktop` on a native Linux x64 or ARM64 build host
to package the Tauri shell, frontend and controller as an AppImage. See
[Linux desktop](linux-desktop.md) for prerequisites and signing.

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

For the App Store **What's New**, choose whether to append to the notes from
the stable release used as the version baseline, reuse them unchanged if
they still apply, or write new ones. If that release has no valid dedicated
App Store notes, write new ones; the GitHub changelog is not a fallback. The
final text must be in English (1-4000 characters) and cover only changes
relevant to iOS app users. The script previews the exact text with the proposed
tag/title and remote default branch commit before confirmation. It stores the
text in a dedicated section alongside GitHub-generated release notes for the
separate iOS publication workflow. Preserve the section's markers if editing
the GitHub release notes later.

The script releases that exact remote commit, regardless of the local branch
or unpushed changes. Do not publish merely to validate the script.

After confirmation, the script first requires a successful complete main
publication for the previewed commit. It reuses a successful scheduled/manual
`binary-release.yml` run unless a later attempt failed or another run is active.
It waits for an active run rather than starting a duplicate, or dispatches the
complete main workflow once if needed. This includes binaries, Docker images,
Apple apps, and verified Pages publication, not just PR checks or CLI compilation.
Dispatch uses GitHub's `2026-03-10` API to identify the exact new run.
If the build or dispatch fails, no tag or release is created; dispatches are
not automatically retried. If remote main changes while waiting, run the
release script again to preview and confirm the new commit. The script also
rechecks that the proposed tag is still available before publishing.

Only typing `yes` at the final prompt publishes. Enter at the bump or What's
New prompt, EOF, or any other confirmation cancels without creating a tag or
release or dispatching a build. The tag and title are identical `vX.Y.Z` strings,
and existing remote tags are rejected. Publication still triggers the versioned
binary and Docker release workflows: rolling artifacts are not promoted into
stable assets, which need the new version and native Release configuration.
It does not run public iOS submission.

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
