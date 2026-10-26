# Development

Clanky is a Bun application with an embedded server, React UI, CLI, and
standalone build. This is the entry point for contributors; technical policies
have one canonical guide rather than copies in `AGENTS.md`.

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

## Choose a development guide

Read the guide relevant to the change, not every guide for every task.

| Work | Canonical guide |
| --- | --- |
| Layers, authorization, execution hosts, backends, persistence, realtime, or concurrency | [Architecture and domain boundaries](development/architecture.md) |
| Coverage decisions, E2E boundaries, fixtures, timeouts, cleanup, or visual validation | [Testing and validation](development/testing.md) |
| UI, settings, routing, framework ownership, or upstream webapp changes | [UI and webapp development](development/webapp.md) |
| Breaking Mesh wire changes | [Protocol evolution](mesh-worker.md#protocol-evolution) |
| Docker, proxy, authentication, production access, or database reset | [Deployment and configuration](deployment.md) |
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

Use the [testing guide](development/testing.md) for prerequisites, narrower
checks, coverage decisions, and required validation.

## Dependency updates

Update registry packages and their transitive resolutions with
`bun update --latest --exact`, then commit `package.json` and `bun.lock`
together. Bun normally enforces the three-day minimum release age in
`bunfig.toml`. An explicitly approved update to freshly published stable
versions can use `--minimum-release-age 0` for that command only; keep the
repository safeguard unchanged.

Check GitHub-hosted packages against their latest stable release tags
separately. Keep CI actions pinned to the corresponding release commit SHAs
and refresh development-container feature versions and digests together in
`.devcontainer/devcontainer-lock.json`. Do not force transitive dependencies
outside their parents' supported ranges.

First-party webapp dependencies use the
[upstream integration workflow](development/webapp.md#upstream-framework-changes),
including the final upstream merge and commit verification.

## Pull request reviews

After opening a PR, wait for review comments before merging unless explicitly
instructed otherwise. Address every requested or suggested change by implementing
it or replying with a reason not to. Merge only after review has arrived and
all feedback has been addressed. This also applies to upstream integration PRs.

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

Review the proposed tag/title and remote default branch commit before confirming
publication. The script releases that exact remote commit, regardless of the
local branch or unpushed changes. Do not publish merely to validate the script.

Only typing `yes` at the final prompt publishes. Enter at the bump prompt,
EOF, or any other confirmation cancels without creating a tag or release.
The tag and title are identical `vX.Y.Z` strings, notes are GitHub-generated,
and existing remote tags are rejected. Publication triggers binary and Docker
release workflows.

Every main push separately updates the rolling `latest` binary prerelease with
a unique embedded build version, checksums, and macOS signing. See
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
