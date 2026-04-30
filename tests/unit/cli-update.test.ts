import { describe, expect, test } from "bun:test";
import {
  buildReleaseAssetName,
  compareReleaseVersions,
  normalizeReleaseTag,
  normalizeReleaseVersion,
  resolveReleasePlatform,
  runCli,
  runUpdateCommand,
} from "../../src/cli";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function binaryResponse(status: number, body: string): Response {
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
      "Unsupported platform: win32-x64. Ralpher releases support Linux and macOS on x64 and arm64.",
    );
  });

  test("check mode reports when an update is available", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: true }, {
      currentVersion: "1.2.3",
      out: (message: string) => output.push(message),
      getPlatform: () => ({
        platform: "linux",
        arch: "x64",
      }),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        return jsonResponse(200, {
          tag_name: "v1.2.4",
          assets: [
            {
              name: "ralpher-cli-v1.2.4-linux-x64",
              browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
            },
          ],
        });
      }),
    });

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
      currentVersion: "1.2.4",
      out: (message: string) => output.push(message),
      getPlatform: () => ({
        platform: "linux",
        arch: "x64",
      }),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        return jsonResponse(200, {
          tag_name: "v1.2.4",
          assets: [
            {
              name: "ralpher-cli-v1.2.4-linux-x64",
              browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
            },
          ],
        });
      }),
      getExecutablePath: () => {
        executablePathResolved = true;
        return "/usr/local/bin/ralpher-cli";
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

  test("installs the requested release over the current executable when no companion binary is present", async () => {
    const output: string[] = [];
    const requests: string[] = [];
    const writes: string[] = [];
    const chmods: Array<{ path: string; mode: number }> = [];
    const renames: Array<{ from: string; to: string }> = [];
    const removals: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: false }, {
      currentVersion: "1.2.3",
      out: (message: string) => output.push(message),
      getPlatform: () => ({
        platform: "linux",
        arch: "x64",
      }),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        if (String(input).includes("/releases/latest")) {
          return jsonResponse(200, {
            tag_name: "v1.2.4",
            assets: [
              {
                name: "ralpher-cli-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
              },
            ],
          });
        }

        return binaryResponse(200, "next-binary");
      }),
      getExecutablePath: () => "/usr/local/bin/ralpher-cli",
      resolveRealPath: async (path: string) => `/resolved${path}`,
      fileExists: async () => false,
      createTempDirectory: async (targetDirectory: string) => `${targetDirectory}/.ralpher-update-temp`,
      writeBinary: async (path: string) => {
        writes.push(path);
      },
      chmodFile: async (path: string, mode: number) => {
        chmods.push({ path, mode });
      },
      renameFile: async (from: string, to: string) => {
        renames.push({ from, to });
      },
      removeFile: async (path: string) => {
        removals.push(path);
      },
      statFile: async () => ({
        mode: 0o100755,
      }),
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
      "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
    ]);
    expect(writes).toEqual([
      "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
    ]);
    expect(chmods).toEqual([
      {
        path: "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
        mode: 0o755,
      },
    ]);
    expect(renames).toEqual([
      {
        from: "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
        to: "/resolved/usr/local/bin/ralpher-cli",
      },
    ]);
    expect(removals).toEqual([
      "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
      "/resolved/usr/local/bin/.ralpher-update-temp",
    ]);
    expect(output).toEqual([
      "Fetching release metadata...",
      "Downloading ralpher-cli-v1.2.4-linux-x64...",
      "Replacing /resolved/usr/local/bin/ralpher-cli...",
      "Updated ralpher-cli 1.2.3 -> 1.2.4 at /resolved/usr/local/bin/ralpher-cli.",
    ]);
  });

  test("updates the companion ralpher binary when it is installed beside the cli", async () => {
    const output: string[] = [];
    const requests: string[] = [];
    const writes: string[] = [];
    const chmods: Array<{ path: string; mode: number }> = [];
    const renames: Array<{ from: string; to: string }> = [];
    const removals: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: false }, {
      currentVersion: "1.2.3",
      out: (message: string) => output.push(message),
      getPlatform: () => ({
        platform: "linux",
        arch: "x64",
      }),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        if (String(input).includes("/releases/latest")) {
          return jsonResponse(200, {
            tag_name: "v1.2.4",
            assets: [
              {
                name: "ralpher-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-v1.2.4-linux-x64",
              },
              {
                name: "ralpher-cli-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
              },
            ],
          });
        }

        return binaryResponse(200, "next-binary");
      }),
      getExecutablePath: () => "/usr/local/bin/ralpher-cli",
      resolveRealPath: async (path: string) => `/resolved${path}`,
      fileExists: async (path: string) => path === "/resolved/usr/local/bin/ralpher",
      createTempDirectory: async (targetDirectory: string) => `${targetDirectory}/.ralpher-update-temp`,
      writeBinary: async (path: string) => {
        writes.push(path);
      },
      chmodFile: async (path: string, mode: number) => {
        chmods.push({ path, mode });
      },
      renameFile: async (from: string, to: string) => {
        renames.push({ from, to });
      },
      removeFile: async (path: string) => {
        removals.push(path);
      },
      statFile: async () => ({
        mode: 0o100755,
      }),
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
      "https://downloads.test/ralpher-v1.2.4-linux-x64",
      "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
    ]);
    expect(writes).toEqual([
      "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-v1.2.4-linux-x64",
      "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
    ]);
    expect(chmods).toEqual([
      {
        path: "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-v1.2.4-linux-x64",
        mode: 0o755,
      },
      {
        path: "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
        mode: 0o755,
      },
    ]);
    expect(renames).toEqual([
      {
        from: "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-v1.2.4-linux-x64",
        to: "/resolved/usr/local/bin/ralpher",
      },
      {
        from: "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
        to: "/resolved/usr/local/bin/ralpher-cli",
      },
    ]);
    expect(removals).toEqual([
      "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-v1.2.4-linux-x64",
      "/resolved/usr/local/bin/.ralpher-update-temp",
      "/resolved/usr/local/bin/.ralpher-update-temp/ralpher-cli-v1.2.4-linux-x64",
      "/resolved/usr/local/bin/.ralpher-update-temp",
    ]);
    expect(output).toEqual([
      "Fetching release metadata...",
      "Downloading ralpher-v1.2.4-linux-x64...",
      "Replacing /resolved/usr/local/bin/ralpher...",
      "Updated ralpher 1.2.3 -> 1.2.4 at /resolved/usr/local/bin/ralpher.",
      "Downloading ralpher-cli-v1.2.4-linux-x64...",
      "Replacing /resolved/usr/local/bin/ralpher-cli...",
      "Updated ralpher-cli 1.2.3 -> 1.2.4 at /resolved/usr/local/bin/ralpher-cli.",
    ]);
  });

  test("reports permission failures clearly", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["update"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        if (String(input).includes("/releases/latest")) {
          return jsonResponse(200, {
            tag_name: "v1.2.4",
            assets: [
              {
                name: "ralpher-cli-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
              },
            ],
          });
        }

        return binaryResponse(200, "next-binary");
      }),
      updateDependencies: {
        currentVersion: "1.2.3",
        getPlatform: () => ({
          platform: "linux",
          arch: "x64",
        }),
        getExecutablePath: () => "/usr/local/bin/ralpher-cli",
        resolveRealPath: async (path: string) => path,
        fileExists: async () => false,
        createTempDirectory: async (targetDirectory: string) => `${targetDirectory}/.ralpher-update-temp`,
        writeBinary: async () => undefined,
        chmodFile: async () => undefined,
        renameFile: async () => {
          const error = new Error("permission denied") as Error & { code?: string };
          error.code = "EACCES";
          throw error;
        },
        removeFile: async () => undefined,
        statFile: async () => ({
          mode: 0o100755,
        }),
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "Fetching release metadata...",
      "Downloading ralpher-cli-v1.2.4-linux-x64...",
      "Replacing /usr/local/bin/ralpher-cli...",
      "ERR:Error: Cannot update /usr/local/bin/ralpher-cli: permission denied. Re-run with permission to modify the installed binary or use the installer script.",
    ]);
  });

  test("reports temp directory permission failures clearly", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["update"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        if (String(input).includes("/releases/latest")) {
          return jsonResponse(200, {
            tag_name: "v1.2.4",
            assets: [
              {
                name: "ralpher-cli-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
              },
            ],
          });
        }

        return binaryResponse(200, "next-binary");
      }),
      updateDependencies: {
        currentVersion: "1.2.3",
        getPlatform: () => ({
          platform: "linux",
          arch: "x64",
        }),
        getExecutablePath: () => "/usr/local/bin/ralpher-cli",
        resolveRealPath: async (path: string) => path,
        fileExists: async () => false,
        createTempDirectory: async () => {
          const error = new Error("permission denied") as Error & { code?: string };
          error.code = "EACCES";
          throw error;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "Fetching release metadata...",
      "ERR:Error: Cannot update /usr/local/bin/ralpher-cli: permission denied. Re-run with permission to modify the installed binary or use the installer script.",
    ]);
  });

  test("fails gracefully when the companion ralpher binary is in use", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runCli(["update"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        if (String(input).includes("/releases/latest")) {
          return jsonResponse(200, {
            tag_name: "v1.2.4",
            assets: [
              {
                name: "ralpher-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-v1.2.4-linux-x64",
              },
              {
                name: "ralpher-cli-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
              },
            ],
          });
        }

        return binaryResponse(200, "next-binary");
      }),
      updateDependencies: {
        currentVersion: "1.2.3",
        getPlatform: () => ({
          platform: "linux",
          arch: "x64",
        }),
        getExecutablePath: () => "/usr/local/bin/ralpher-cli",
        resolveRealPath: async (path: string) => path,
        fileExists: async (path: string) => path === "/usr/local/bin/ralpher",
        createTempDirectory: async (targetDirectory: string) => `${targetDirectory}/.ralpher-update-temp`,
        writeBinary: async () => undefined,
        chmodFile: async () => undefined,
        renameFile: async (_from: string, to: string) => {
          if (to === "/usr/local/bin/ralpher") {
            const error = new Error("text file busy") as Error & { code?: string };
            error.code = "ETXTBSY";
            throw error;
          }
        },
        removeFile: async () => undefined,
        statFile: async () => ({
          mode: 0o100755,
        }),
      },
    });

    expect(exitCode).toBe(1);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/latest",
      "https://downloads.test/ralpher-v1.2.4-linux-x64",
    ]);
    expect(output).toEqual([
      "Fetching release metadata...",
      "Downloading ralpher-v1.2.4-linux-x64...",
      "Replacing /usr/local/bin/ralpher...",
      "ERR:Error: Cannot update /usr/local/bin/ralpher: the binary is currently in use. Stop any running Ralpher process and try again.",
    ]);
  });

  test("specific-version updates install the requested tag", async () => {
    const output: string[] = [];
    const requests: string[] = [];

    const exitCode = await runUpdateCommand({ checkOnly: false, version: "1.2.4" }, {
      currentVersion: "1.2.3",
      out: (message: string) => output.push(message),
      getPlatform: () => ({
        platform: "linux",
        arch: "x64",
      }),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        if (String(input).includes("/releases/tags/v1.2.4")) {
          return jsonResponse(200, {
            tag_name: "v1.2.4",
            assets: [
              {
                name: "ralpher-cli-v1.2.4-linux-x64",
                browser_download_url: "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
              },
            ],
          });
        }

        return binaryResponse(200, "next-binary");
      }),
      getExecutablePath: () => "/usr/local/bin/ralpher-cli",
      resolveRealPath: async (path: string) => path,
      fileExists: async () => false,
      createTempDirectory: async (targetDirectory: string) => `${targetDirectory}/.ralpher-update-temp`,
      writeBinary: async () => undefined,
      chmodFile: async () => undefined,
      renameFile: async () => undefined,
      removeFile: async () => undefined,
      statFile: async () => ({
        mode: 0o100755,
      }),
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/pablozaiden/ralpher/releases/tags/v1.2.4",
      "https://downloads.test/ralpher-cli-v1.2.4-linux-x64",
    ]);
    expect(output).toEqual([
      "Fetching release metadata for v1.2.4...",
      "Downloading ralpher-cli-v1.2.4-linux-x64...",
      "Replacing /usr/local/bin/ralpher-cli...",
      "Installed ralpher-cli 1.2.4 at /usr/local/bin/ralpher-cli.",
    ]);
  });
});
