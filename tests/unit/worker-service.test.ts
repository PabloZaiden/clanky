import { describe, expect, test } from "bun:test";
import {
  detectWorkerServicePlatform,
  getWorkerServicePaths,
  isStandaloneClankyInvocation,
  parseWorkerServiceArgs,
  renderLaunchAgent,
  renderSystemdUnit,
  type WorkerServiceConfiguration,
} from "../../src/cli/worker-service";

function configuration(
  platform: "darwin" | "linux",
): WorkerServiceConfiguration {
  return {
    platform,
    paths: getWorkerServicePaths(
      platform,
      platform === "darwin" ? "/Users/alice" : "/home/alice",
      platform === "darwin" ? 501 : undefined,
    ),
    binaryPath: platform === "darwin"
      ? "/Applications/Clanky Worker/clanky"
      : "/home/alice/.local/bin/clanky",
    dataDir: platform === "darwin" ? "/Users/alice/.clanky" : "/home/alice/.clanky",
    workerDirectory: platform === "darwin" ? "/Users/alice/Work Spaces" : "/srv/workspaces",
    workerExecutionEnabled: true,
    host: "127.0.0.1",
    port: 4180,
    homeDirectory: platform === "darwin" ? "/Users/alice" : "/home/alice",
    userName: "alice",
    environment: {
      CLANKY_DATA_DIR: platform === "darwin" ? "/Users/alice/.clanky" : "/home/alice/.clanky",
      CLANKY_HOST: "127.0.0.1",
      CLANKY_PORT: "4180",
      HOME: platform === "darwin" ? "/Users/alice" : "/home/alice",
      ...(platform === "linux" ? { PATH: "/home/alice/.local/bin:/usr/bin:/bin" } : {}),
    },
  };
}

describe("worker service command parsing", () => {
  test("accepts lifecycle operations and the no-start install flag", () => {
    expect(parseWorkerServiceArgs(["install", "--no-start"])).toEqual({
      operation: "install",
      noStart: true,
    });
    expect(parseWorkerServiceArgs(["restart"])).toEqual({
      operation: "restart",
      noStart: false,
    });
  });

  test("rejects options on operations that do not support them", () => {
    expect(() => parseWorkerServiceArgs(["status", "--no-start"])).toThrow(
      "Unknown worker service option",
    );
    expect(() => parseWorkerServiceArgs(["install", "--no-start", "--no-start"])).toThrow(
      "Unknown worker service option",
    );
  });
});

describe("worker service definitions", () => {
  test("detects only the supported operating systems", () => {
    expect(detectWorkerServicePlatform("darwin")).toBe("darwin");
    expect(detectWorkerServicePlatform("linux")).toBe("linux");
    expect(() => detectWorkerServicePlatform("win32")).toThrow(
      "supported on macOS and Linux",
    );
  });

  test("recognizes standalone Bun binaries but not source entrypoints", () => {
    expect(isStandaloneClankyInvocation("/$bunfs/root/index.ts", "/usr/local/bin/clanky")).toBe(true);
    expect(isStandaloneClankyInvocation("/usr/local/bin/clanky", "/usr/local/bin/clanky")).toBe(true);
    expect(isStandaloneClankyInvocation("/workspace/src/index.ts", "/usr/local/bin/bun")).toBe(false);
  });

  test("renders a user LaunchAgent with the login shell and explicit worker command", () => {
    const plist = renderLaunchAgent(configuration("darwin"));
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/bin/zsh</string>");
    expect(plist).toContain("<string>-lic</string>");
    expect(plist).toContain("CLANKY_DATA_DIR=/Users/alice/.clanky");
    expect(plist).toContain("/Applications/Clanky Worker/clanky");
    expect(plist).toContain("--worker-directory");
    expect(plist).not.toContain("CLANKY_API_KEY");
  });

  test("renders a boot-time systemd service for the installing user", () => {
    const unit = renderSystemdUnit(configuration("linux"));
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("User=\"alice\"");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("ExecStart=\"/home/alice/.local/bin/clanky\"");
    expect(unit).toContain("CLANKY_DATA_DIR=/home/alice/.clanky");
    expect(unit).not.toContain("CLANKY_API_KEY");
  });
});
