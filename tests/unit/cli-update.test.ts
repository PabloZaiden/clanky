import { describe, expect, test } from "bun:test";
import {
  buildReleaseAssetName,
  compareReleaseVersions,
  normalizeReleaseTag,
  normalizeReleaseVersion,
  resolveReleasePlatform,
  runCli,
  runUpdateCommand,
  type CliUpdateDependencies,
} from "../../src/cli";

type AssetBodyMap = Record<string, string>;

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/octet-stream",
    },
  });
}

function createFetchMock(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect: fetch.preconnect,
  }) as typeof fetch;
}

function createRelease(tag: string, assetBodies: AssetBodyMap): unknown {
  return {
    tag_name: tag,
    assets: Object.keys(assetBodies).flatMap((assetName) => [
      {
        name: assetName,
        browser_download_url: `https://downloads.test/${assetName}`,
      },
      {
        name: `${assetName}.sha256`,
        browser_download_url: `https://downloads.test/${assetName}.sha256`,
      },
    ]),
  };
}

function createUpdateDependencies(options: {
  currentVersion?: string;
  releaseTag?: string;
  assetBodies?: AssetBodyMap;
  output?: string[];
  errors?: string[];
  requests?: string[];
  installedPaths?: Set<string>;
  renameFile?: CliUpdateDependencies["renameFile"];
} = {}): CliUpdateDependencies {
  const releaseTag = options.releaseTag ?? "v1.2.4";
  const assetBodies = options.assetBodies ?? {
    [`ralpher-cli-${releaseTag}-linux-x64`]: "cli-binary",
  };
  const output = options.output ?? [];
  const errors = options.errors ?? [];
  const requests = options.requests ?? [];
  const installedPaths = options.installedPaths ?? new Set(["/usr/local/bin/ralpher-cli"]);

  return {
    currentVersion: options.currentVersion ?? "1.2.3",
    out: (message: string) => output.push(message),
    err: (message: string) => errors.push(message),
    getPlatform: () => ({
      platform: "linux",
      arch: "x64",
    }),
    getExecutablePath: () => "/usr/local/bin/ralpher-cli",
    resolveRealPath: async (path: string) => path,
    fileExists: async (path: string) => installedPaths.has(path),
    createTempDirectory: async (_targetDirectory: string, prefix: string) => `/tmp/${prefix}test`,
    writeBinary: async () => {},
    chmodFile: async () => {},
    renameFile: options.renameFile ?? (async () => {}),
    removeFile: async () => {},
    statFile: async () => ({ mode: 0o755 }),
    fetchFn: createFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/releases/")) {
        expect(init?.headers).toMatchObject({
          accept: "application/vnd.github+json",
        });
        return jsonResponse(200, createRelease(releaseTag, assetBodies));
      }

      const assetName = url.replace("https://downloads.test/", "");
      if (assetName.endsWith(".sha256")) {
        const binaryAssetName = assetName.slice(0, -".sha256".length);
        return textResponse(200, `${sha256(assetBodies[binaryAssetName] ?? "")}  ${binaryAssetName}`);
      }
      return textResponse(200, assetBodies[assetName] ?? "");
    }),
  };
}

describe("ralpher cli update", () => {
  test("normalizes release versions and asset names", () => {
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseTag("1.2.3")).toBe("v1.2.3");
    expect(buildReleaseAssetName("v1.2.3", {
      os: "linux",
      arch: "arm64",
    })).toBe("ralpher-cli-v1.2.3-linux-arm64");
  });

  test("compares semver versions including prereleases", () => {
    expect(compareReleaseVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareReleaseVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.2.3-beta.1", "1.2.3")).toBeLessThan(0);
    expect(compareReleaseVersions("1.2.3-beta.2", "1.2.3-beta.1")).toBeGreaterThan(0);
  });

  test("maps supported platforms and rejects unsupported ones", () => {
    expect(resolveReleasePlatform("linux", "x64")).toEqual({
      os: "linux",
      arch: "x64",
    });
    expect(() => resolveReleasePlatform("win32", "x64")).toThrow(
      "Unsupported platform: win32-x64. Supported release targets are Linux and macOS on x64 and arm64.",
    );
  });

  test("check mode reports when an update is available", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: true }, createUpdateDependencies({
      output,
      requests,
    }));

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
    ]);
    expect(output).toEqual([
      "Fetching release metadata...",
      "Update available: 1.2.3 -> 1.2.4",
    ]);
  });

  test("plain update does not redownload when already up to date", async () => {
    const output: string[] = [];
    const requests: string[] = [];
    let executablePathResolved = false;

    const exitCode = await runUpdateCommand({ checkOnly: false }, {
      ...createUpdateDependencies({
        currentVersion: "1.2.4",
        output,
        requests,
      }),
      resolveRealPath: async (path: string) => {
        executablePathResolved = true;
        return path;
      },
    });

    expect(exitCode).toBe(0);
    expect(executablePathResolved).toBe(false);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
    ]);
    expect(output).toEqual([
      "Fetching release metadata...",
      "ralpher-cli 1.2.4 is up to date.",
    ]);
  });

  test("updates installed cli binary with checksum verification", async () => {
    const output: string[] = [];
    const requests: string[] = [];
    const renames: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: false }, {
      ...createUpdateDependencies({
        output,
        requests,
      }),
      renameFile: async (from: string, to: string) => {
        renames.push(`${from}->${to}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
      "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
      "https://downloads.test/ralpher-cli-v1.2.4-linux-x64.sha256",
    ]);
    expect(renames).toEqual([
      "/usr/local/bin/ralpher-cli->/tmp/.ralpher-cli-update-test/ralpher-cli.backup",
      "/tmp/.ralpher-cli-update-test/ralpher-cli-v1.2.4-linux-x64->/usr/local/bin/ralpher-cli",
    ]);
    expect(output).toEqual([
      "Fetching release metadata...",
      "Downloading ralpher-cli-v1.2.4-linux-x64...",
      "Downloading ralpher-cli-v1.2.4-linux-x64.sha256...",
      "Verified checksum for ralpher-cli-v1.2.4-linux-x64.",
      "Replacing /usr/local/bin/ralpher-cli...",
      "Updated ralpher-cli 1.2.3 -> 1.2.4 at /usr/local/bin/ralpher-cli.",
    ]);
  });

  test("updates companion server binary when installed beside cli", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: false }, createUpdateDependencies({
      output,
      requests,
      installedPaths: new Set([
        "/usr/local/bin/ralpher",
        "/usr/local/bin/ralpher-cli",
      ]),
      assetBodies: {
        "ralpher-v1.2.4-linux-x64": "server-binary",
        "ralpher-cli-v1.2.4-linux-x64": "cli-binary",
      },
    }));

    expect(exitCode).toBe(0);
    expect(requests).toContain("https://downloads.test/ralpher-v1.2.4-linux-x64");
    expect(requests).toContain("https://downloads.test/ralpher-cli-v1.2.4-linux-x64");
    expect(output).toContain("Updated ralpher 1.2.3 -> 1.2.4 at /usr/local/bin/ralpher.");
    expect(output).toContain("Updated ralpher-cli 1.2.3 -> 1.2.4 at /usr/local/bin/ralpher-cli.");
  });

  test("explicit version fetches a tagged release and reports install", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: false, version: "1.2.4" }, createUpdateDependencies({
      output,
      requests,
    }));

    expect(exitCode).toBe(0);
    expect(requests[0]).toBe("https://api.github.com/repos/pablozaiden/ralpher/releases/tags/v1.2.4");
    expect(output).toContain("Installed ralpher-cli 1.2.4 at /usr/local/bin/ralpher-cli.");
  });

  test("surfaces shared installer failures", async () => {
    await expect(runUpdateCommand({ checkOnly: false }, {
      ...createUpdateDependencies(),
      renameFile: async () => {
        const error = new Error("busy") as Error & { code: string };
        error.code = "EBUSY";
        throw error;
      },
    })).rejects.toThrow(
      "Cannot update ralpher-cli: the binary is currently in use. Stop any running Ralpher CLI process and try again.",
    );
  });

  test("rejects source-mode updates", async () => {
    await expect(runUpdateCommand({ checkOnly: false }, {
      ...createUpdateDependencies(),
      getExecutablePath: () => "/usr/local/bin/bun",
    })).rejects.toThrow(
      "ralpher-cli update only works from an installed Ralpher CLI binary. Use the installer script when running from source.",
    );
  });

  test("runCli wires update command dependencies through the adapter", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runCli(["update", "--check"], {
      out: (message: string) => output.push(message),
      updateDependencies: createUpdateDependencies({
        output,
        requests,
      }),
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
    ]);
    expect(output.at(-1)).toBe("Update available: 1.2.3 -> 1.2.4");
  });
});
