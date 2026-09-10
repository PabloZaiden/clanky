import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectWorkerServicePlatform,
  getWorkerServiceStatus,
  getWorkerServicePaths,
  isStandaloneClankyInvocation,
  parseWorkerServiceArgs,
  renderLaunchAgent,
  renderSystemdUnit,
  type WorkerServiceConfiguration,
} from "../../src/cli/worker-service";
import {
  getWorkerSshAgentPaths,
  parseWorkerSshAgentArgs,
  renderShellStartupBlock,
  renderSshAgentShellHelper,
  renderSshAgentSystemdUnit,
  removeShellStartupBlock,
  unlockWorkerSshAgent,
  upsertShellStartupBlock,
  type WorkerSshAgentConfiguration,
} from "../../src/cli/worker-ssh-agent";

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
    insecure: false,
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

function sshAgentConfiguration(): WorkerSshAgentConfiguration {
  return {
    paths: getWorkerSshAgentPaths("/home/alice"),
    homeDirectory: "/home/alice",
    userName: "alice",
    binaryPath: "/home/alice/.local/bin/clanky",
    sshAgentPath: "/usr/bin/ssh-agent",
    sshAddPath: "/usr/bin/ssh-add",
  };
}

describe("worker SSH-agent command and shell integration", () => {
  test("parses unlock and status operations", () => {
    expect(parseWorkerSshAgentArgs(["unlock", "--if-needed"])).toEqual({
      operation: "unlock",
      ifNeeded: true,
    });
    expect(parseWorkerSshAgentArgs(["status"])).toEqual({
      operation: "status",
      ifNeeded: false,
    });
    expect(() => parseWorkerSshAgentArgs(["status", "--if-needed"])).toThrow(
      "Unknown worker ssh-agent option",
    );
  });

  test("renders a per-user systemd agent without private key material", () => {
    const unit = renderSshAgentSystemdUnit(sshAgentConfiguration());
    expect(unit).toContain("User=alice");
    expect(unit).toContain("ExecStartPre=/usr/bin/mkdir -p /home/alice/.clanky/worker-ssh-agent");
    expect(unit).toContain("ExecStartPre=/usr/bin/chmod 0700 /home/alice/.clanky/worker-ssh-agent");
    expect(unit).toContain("ExecStartPre=/usr/bin/rm -f /home/alice/.clanky/worker-ssh-agent/agent.sock");
    expect(unit).not.toContain("RuntimeDirectory=");
    expect(unit).toContain(
      "ExecStart=/usr/bin/ssh-agent -D -a /home/alice/.clanky/worker-ssh-agent/agent.sock",
    );
    expect(unit).not.toContain("ssh-add");
    expect(unit).not.toContain("passphrase");
    expect(unit).not.toContain("id_ed25519");
  });

  test("uses systemd escaping for agent executable and socket paths", () => {
    const base = sshAgentConfiguration();
    const unit = renderSshAgentSystemdUnit({
      ...base,
      sshAgentPath: "/usr/bin/ssh$agent",
      paths: {
        ...base.paths,
        socketPath: "/run/$agent.sock",
      },
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/ssh$$agent" -D -a "/run/$$agent.sock"',
    );
  });

  test("renders the worker dependency and stable SSH_AUTH_SOCK", () => {
    const unit = renderSystemdUnit(configuration("linux"));
    expect(unit).toContain("Requires=clanky-worker-ssh-agent.service");
    expect(unit).toContain("PartOf=clanky-worker-ssh-agent.service");
    expect(unit).toContain("After=network-online.target clanky-worker-ssh-agent.service");
    expect(unit).toContain(
      "Environment=SSH_AUTH_SOCK=/home/alice/.clanky/worker-ssh-agent/agent.sock",
    );
  });

  test("renders an unlock helper and interactive shell block", () => {
    const agent = sshAgentConfiguration();
    const helper = renderSshAgentShellHelper(agent);
    const block = renderShellStartupBlock(agent.paths.helperPath);
    expect(helper).toContain(
      "export SSH_AUTH_SOCK=/home/alice/.clanky/worker-ssh-agent/agent.sock",
    );
    expect(helper).toContain(
      "/home/alice/.local/bin/clanky worker ssh-agent unlock --if-needed",
    );
    expect(helper).not.toContain("ssh-add -p");
    expect(block).toContain("*i*)");
    expect(block).toContain(". /home/alice/.clanky/worker-ssh-agent.sh");
    expect(agent.paths.bashProfilePath).toBe("/home/alice/.bash_profile");
    expect(agent.paths.bashLoginPath).toBe("/home/alice/.bash_login");
    expect(agent.paths.profilePath).toBe("/home/alice/.profile");
    expect(agent.paths.zshProfilePath).toBe("/home/alice/.zprofile");
  });

  test("updates one managed block without duplicating it and removes it cleanly", () => {
    const helperPath = "/home/alice/.clanky/worker-ssh-agent.sh";
    const initial = "export EDITOR=vim\n";
    const once = upsertShellStartupBlock(initial, helperPath);
    const twice = upsertShellStartupBlock(once, helperPath);
    expect(twice).toBe(once);
    expect(twice.match(/# >>> clanky worker ssh-agent >>>/g)?.length).toBe(1);
    expect(removeShellStartupBlock(twice)).toBe(initial);
  });

  test("unlocks an empty agent once and skips ssh-add when identities are loaded", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "clanky-worker-ssh-agent-"));
    const sshAddPath = join(homeDirectory, "fake-ssh-add");
    await writeFile(
      sshAddPath,
      [
        "#!/bin/sh",
        "state=\"$HOME/.fake-agent-unlocked\"",
        "if [ \"$1\" = \"-l\" ]; then",
        "  if [ -f \"$state\" ]; then",
        "    printf '%s\\n' '256 SHA256:test clanky@test (ED25519)'",
        "    exit 0",
        "  fi",
        "  exit 1",
        "fi",
        "printf '%s\\n' loaded > \"$state\"",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(sshAddPath, 0o700);
    try {
      const configuration = {
        ...sshAgentConfiguration(),
        homeDirectory,
        paths: getWorkerSshAgentPaths(homeDirectory),
        sshAddPath,
      };
      await expect(unlockWorkerSshAgent(configuration)).resolves.toEqual({
        changed: true,
        identities: 1,
      });
      await expect(unlockWorkerSshAgent(configuration)).resolves.toEqual({
        changed: false,
        identities: 1,
      });
      expect(await readFile(join(homeDirectory, ".fake-agent-unlocked"), "utf8")).toBe("loaded\n");
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});

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

  test("renders a boot-time systemd service with canonical unquoted simple values", () => {
    const unit = renderSystemdUnit(configuration("linux"));
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("User=alice");
    expect(unit).not.toContain('User="alice"');
    expect(unit).toContain("WorkingDirectory=/srv/workspaces");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(
      "ExecStart=/home/alice/.local/bin/clanky serve --mesh-worker true --worker-directory /srv/workspaces --worker-execution-enabled true --insecure false",
    );
    expect(unit).toContain("CLANKY_DATA_DIR=/home/alice/.clanky");
    expect(unit).not.toContain('"');
    expect(unit).not.toContain("CLANKY_API_KEY");
  });

  test("quotes only systemd values that require grouping or escaping", () => {
    const base = configuration("linux");
    const unit = renderSystemdUnit({
      ...base,
      binaryPath: "/home/alice/bin/clanky worker",
      workerDirectory: "/srv/worker spaces",
      environment: {
        ...base.environment,
        CLANKY_LABEL: "worker service",
      },
    });
    expect(unit).toContain('WorkingDirectory="/srv/worker spaces"');
    expect(unit).toContain('Environment="CLANKY_LABEL=worker service"');
    expect(unit).toContain(
      'ExecStart="/home/alice/bin/clanky worker" serve --mesh-worker true --worker-directory "/srv/worker spaces" --worker-execution-enabled true --insecure false',
    );
  });

  test("escapes ExecStart dollars without escaping environment dollars or backticks", () => {
    const base = configuration("linux");
    const unit = renderSystemdUnit({
      ...base,
      binaryPath: "/home/alice/bin/$clanky`worker",
      workerDirectory: "/srv/$clanky`workspace",
      environment: {
        ...base.environment,
        CLANKY_PUBLIC_BASE_URL: "https://$host.example",
      },
    });
    expect(unit).toContain(
      'ExecStart="/home/alice/bin/$$clanky`worker" serve --mesh-worker true --worker-directory "/srv/$$clanky`workspace" --worker-execution-enabled true --insecure false',
    );
    expect(unit).toContain('Environment="CLANKY_PUBLIC_BASE_URL=https://$host.example"');
  });

  test("checks launchctl even when the macOS plist is missing", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-worker-status-"));
    try {
      const paths = {
        ...getWorkerServicePaths("darwin", "/Users/alice", 501),
        servicePath: join(temporaryDirectory, "missing.plist"),
      };
      const status = await getWorkerServiceStatus(paths, async (_command, _args) => {
        return {
          exitCode: 0,
          stdout: "state = running\n",
          stderr: "",
        };
      });
      expect(status).toMatchObject({
        installed: false,
        loaded: true,
        running: true,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("checks systemctl even when the Linux unit file is missing", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-worker-status-"));
    const calls: string[][] = [];
    try {
      const paths = {
        ...getWorkerServicePaths("linux", "/home/alice"),
        servicePath: join(temporaryDirectory, "missing.service"),
      };
      const status = await getWorkerServiceStatus(paths, async (_command, args) => {
        calls.push([...args]);
        if (args[1] === "is-active") {
          return { exitCode: 0, stdout: "active\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "not-found\n", stderr: "" };
      });
      expect(status).toMatchObject({
        installed: false,
        loaded: false,
        running: true,
      });
      expect(calls).toEqual([
        ["systemctl", "is-active", "clanky-worker.service"],
        ["systemctl", "is-enabled", "clanky-worker.service"],
      ]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
