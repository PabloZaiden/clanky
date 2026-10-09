import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkerLauncher,
  getWorkerPaths,
  shellQuote,
} from "../../src/core/provisioning/worker-assets";

const LATEST_PRERELEASE_TAG = "v6.2.0-rc.2";
const BINARY_ASSET_NAME = `clanky-${LATEST_PRERELEASE_TAG}-linux-x64`;
const BINARY_CONTENT = "verified Clanky prerelease binary";
const RELEASE_BINARY_URL =
  `https://github.com/pablozaiden/clanky/releases/download/${LATEST_PRERELEASE_TAG}/${BINARY_ASSET_NAME}`;
const RELEASE_CHECKSUM_URL = `${RELEASE_BINARY_URL}.sha256`;
const RELEASE_PAGE_ONE_URL =
  "https://api.github.com/repos/pablozaiden/clanky/releases?per_page=100&page=1";
const RELEASE_PAGE_TWO_URL =
  "https://api.github.com/repos/pablozaiden/clanky/releases?per_page=100&page=2";
const BINARY_SHA256 = createHash("sha256").update(BINARY_CONTENT).digest("hex");

async function runPrereleaseLauncher(
  checksum: string,
): Promise<{ exitCode: number; stderr: string; binary: string | null }> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-worker-launcher-"));
  try {
    const paths = getWorkerPaths(temporaryDirectory, temporaryDirectory);
    const shimDirectory = join(temporaryDirectory, "shims");
    await mkdir(paths.containerRoot, { recursive: true });
    await mkdir(shimDirectory, { recursive: true });

    const releasesPageOne = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `v6.0.${index}`,
      draft: false,
      prerelease: false,
      published_at: "2026-10-01T00:00:00Z",
    }));
    releasesPageOne[99] = {
      tag_name: "v6.2.0-rc.1",
      draft: false,
      prerelease: true,
      published_at: "2026-10-02T00:00:00Z",
    };
    const releasesPageTwo = [{
      tag_name: LATEST_PRERELEASE_TAG,
      draft: false,
      prerelease: true,
      published_at: "2026-10-09T00:00:00Z",
    }];
    const pageOnePath = join(temporaryDirectory, "releases-page-1.json");
    const pageTwoPath = join(temporaryDirectory, "releases-page-2.json");
    await Bun.write(pageOnePath, JSON.stringify(releasesPageOne));
    await Bun.write(pageTwoPath, JSON.stringify(releasesPageTwo));
    await Bun.write(join(paths.containerRoot, "install-runtime.sh"), "#!/bin/sh\nexit 0\n");
    const launcherPath = join(paths.containerRoot, "launcher.sh");
    await Bun.write(launcherPath, buildWorkerLauncher(paths, true));

    const nodeShim = join(shimDirectory, "node");
    await Bun.write(nodeShim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
    await chmod(nodeShim, 0o755);
    const npmShim = join(shimDirectory, "npm");
    await Bun.write(npmShim, "#!/bin/sh\nexit 0\n");
    await chmod(npmShim, 0o755);
    const curlShim = join(shimDirectory, "curl");
    await Bun.write(curlShim, `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --proto) shift 2 ;;
    -o) output=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
if [ "$url" = "$CLANKY_TEST_RELEASE_PAGE_ONE_URL" ]; then
  cat "$CLANKY_TEST_RELEASE_PAGE_ONE"
elif [ "$url" = "$CLANKY_TEST_RELEASE_PAGE_TWO_URL" ]; then
  cat "$CLANKY_TEST_RELEASE_PAGE_TWO"
elif [ "$url" = "$CLANKY_TEST_RELEASE_BINARY_URL" ]; then
  printf '%s' "$CLANKY_TEST_BINARY_CONTENT" > "$output"
elif [ "$url" = "$CLANKY_TEST_RELEASE_CHECKSUM_URL" ]; then
  printf '%s  %s\\n' "$CLANKY_TEST_CHECKSUM" "$CLANKY_TEST_BINARY_NAME" > "$output"
else
  echo "Unexpected test URL: $url" >&2
  exit 1
fi
`);
    await chmod(curlShim, 0o755);

    const child = Bun.spawn(["sh", launcherPath], {
      cwd: temporaryDirectory,
      env: {
        HOME: temporaryDirectory,
        PATH: `${shimDirectory}:${process.env["PATH"] ?? ""}`,
        CLANKY_TEST_RELEASE_PAGE_ONE_URL: RELEASE_PAGE_ONE_URL,
        CLANKY_TEST_RELEASE_PAGE_TWO_URL: RELEASE_PAGE_TWO_URL,
        CLANKY_TEST_RELEASE_PAGE_ONE: pageOnePath,
        CLANKY_TEST_RELEASE_PAGE_TWO: pageTwoPath,
        CLANKY_TEST_RELEASE_BINARY_URL: RELEASE_BINARY_URL,
        CLANKY_TEST_RELEASE_CHECKSUM_URL: RELEASE_CHECKSUM_URL,
        CLANKY_TEST_BINARY_NAME: BINARY_ASSET_NAME,
        CLANKY_TEST_BINARY_CONTENT: BINARY_CONTENT,
        CLANKY_TEST_CHECKSUM: checksum,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const [, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const binaryPath = Bun.file(paths.containerBinary);
    return {
      exitCode,
      stderr,
      binary: await binaryPath.exists() ? await binaryPath.text() : null,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

describe("automatic worker launcher prerelease selection", () => {
  // The Devbox boot hook runs on the workspace host; exercise the generated
  // script with local network shims because the API test cannot execute it.
  test("installs the newest published prerelease across release pages", async () => {
    const result = await runPrereleaseLauncher(BINARY_SHA256);

    expect(result.exitCode).toBe(0);
    expect(result.binary).toBe(BINARY_CONTENT);
  });

  test("rejects a prerelease binary with an invalid checksum", async () => {
    const result = await runPrereleaseLauncher("0".repeat(64));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Checksum verification failed");
    expect(result.binary).toBeNull();
  });
});
