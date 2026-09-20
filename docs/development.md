# Development

Clanky is a Bun application with an embedded server, web UI, CLI, and
standalone build.

## Set up a source checkout

```bash
git clone https://github.com/pablozaiden/clanky.git
cd clanky
bun install
```

Run the combined development server:

```bash
bun dev
```

The application is available at <http://localhost:3000>. Use an isolated
`CLANKY_DATA_DIR` for local experiments or visual validation.

## Build and test

Build the standalone artifacts and run the test suite:

```bash
bun run build
bun run test
```

The build writes standalone artifacts to `dist/`.

Useful targeted commands:

```bash
bun run tsc
bun run test:backend
bun run test:native-worker-e2e
bun run test:changed
```

Set `CLANKY_MOCK_ACP=true` when local tests should use the built-in fake ACP
runtime instead of launching a provider CLI.

Run `bun run build && bun run test` before considering a change complete.

## Demo data

The demo generator creates disposable data for UI validation:

```bash
CLANKY_DISABLE_PASSKEY=true \
  bun tests/test-data-generation/generate-demo-ui-data.ts \
  --data-dir /tmp/clanky-demo
```

Use a temporary data directory. The generator is intended for local
validation, not for production data.

## Release metadata

Release targets, binary artifacts, Docker platforms, and installer projections
are declared in `.github/release-metadata.json`. Check or regenerate the
generated installer metadata with:

```bash
bun run release:metadata:check
bun run release:metadata:generate
```

Edit the canonical release metadata, not the generated installer projection.
