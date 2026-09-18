import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  renderWindowsService,
  resolveWindowsServiceUserDomain,
  runMacWorkerServiceOperation,
  type WorkerServiceConfiguration,
  type WorkerServiceProcessResult,
} from "../../src/cli/worker-service";
import {
  getWindowsWorkerServiceStatus,
  installWindowsWorkerService,
  runWindowsWorkerServiceOperation,
  uninstallWindowsWorkerService,
  type WindowsWorkerServiceDefinition,
  type WindowsWorkerServicePaths,
} from "../../src/cli/worker-service-windows";
import {
  getWorkerSshAgentPaths,
  renderSshAgentRelayServiceUnit,
  renderSshAgentRelaySocketUnit,
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
  platform: "darwin" | "linux" | "win32",
): WorkerServiceConfiguration {
  if (platform === "win32") {
    return {
      platform,
      paths: getWorkerServicePaths(
        platform,
        "C:\\Users\\alice",
        undefined,
        "C:\\Users\\alice\\.clanky",
      ),
      binaryPath: "C:\\Users\\alice\\.local\\bin\\clanky.exe",
      dataDir: "C:\\Users\\alice\\.clanky",
      workerDirectory: "C:\\Work Spaces",
      workerExecutionEnabled: true,
      relayOnly: false,
      insecure: false,
      host: "127.0.0.1",
      port: 4180,
      homeDirectory: "C:\\Users\\alice",
      userName: "alice",
      userDomain: "WORKSTATION",
      serviceWrapperPath: "C:\\Tools\\WinSW-x64.exe",
      environment: {
        CLANKY_DATA_DIR: "C:\\Users\\alice\\.clanky",
        CLANKY_HOST: "127.0.0.1",
        CLANKY_PORT: "4180",
        HOME: "C:\\Users\\alice",
        USERPROFILE: "C:\\Users\\alice",
        USERNAME: "alice",
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\alice",
        PATH: "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32",
      },
    };
  }
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
    relayOnly: false,
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
    ...(platform === "linux" ? { sshAgent: sshAgentConfiguration() } : {}),
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
  test("parses unlock, status, and relay operations", () => {
    expect(parseWorkerSshAgentArgs(["unlock", "--if-needed"])).toEqual({
      operation: "unlock",
      ifNeeded: true,
    });
    expect(parseWorkerSshAgentArgs(["status"])).toEqual({
      operation: "status",
      ifNeeded: false,
    });
    expect(parseWorkerSshAgentArgs(["relay"])).toEqual({
      operation: "relay",
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
    expect(unit).toContain("ExecStartPre=/usr/bin/rm -f /home/alice/.clanky/worker-ssh-agent/agent-upstream.sock");
    expect(unit).not.toContain("RuntimeDirectory=");
    expect(unit).toContain(
      "ExecStart=/usr/bin/ssh-agent -D -a /home/alice/.clanky/worker-ssh-agent/agent-upstream.sock",
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
        upstreamSocketPath: "/run/$agent.sock",
      },
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/ssh$$agent" -D -a "/run/$$agent.sock"',
    );
  });

  test("renders a systemd-owned stable relay socket and service", () => {
    const agent = sshAgentConfiguration();
    const socketUnit = renderSshAgentRelaySocketUnit(agent);
    const serviceUnit = renderSshAgentRelayServiceUnit(agent);
    expect(socketUnit).toContain(
      "ListenStream=/home/alice/.clanky/worker-ssh-agent/agent.sock",
    );
    expect(socketUnit).toContain("SocketUser=alice");
    expect(socketUnit).toContain("SocketMode=0600");
    expect(socketUnit).toContain(
      "Service=clanky-worker-ssh-agent-relay.service",
    );
    expect(serviceUnit).toContain(
      "Requires=clanky-worker-ssh-agent.service clanky-worker-ssh-agent-relay.socket",
    );
    expect(serviceUnit).toContain(
      "ExecStart=/home/alice/.local/bin/clanky worker ssh-agent relay",
    );
    expect(serviceUnit).toContain("Environment=HOME=/home/alice");
    expect(serviceUnit).not.toContain("passphrase");
  });

  test("does not escape dollar signs in the relay socket path", () => {
    const agent = sshAgentConfiguration();
    const socketUnit = renderSshAgentRelaySocketUnit({
      ...agent,
      paths: {
        ...agent.paths,
        socketPath: "/home/alice/.clanky/$agent.sock",
      },
    });

    expect(
      socketUnit.split("\n").find((line) => line.startsWith("ListenStream=")),
    ).toBe('ListenStream="/home/alice/.clanky/$agent.sock"');
  });

  test("renders the worker dependency and stable SSH_AUTH_SOCK", () => {
    const unit = renderSystemdUnit(configuration("linux"));
    expect(unit).toContain(
      "Requires=clanky-worker-ssh-agent.service clanky-worker-ssh-agent-relay.socket",
    );
    expect(unit).toContain(
      "PartOf=clanky-worker-ssh-agent.service clanky-worker-ssh-agent-relay.socket",
    );
    expect(unit).toContain(
      "After=network-online.target clanky-worker-ssh-agent.service clanky-worker-ssh-agent-relay.socket",
    );
    expect(unit).toContain(
      "Environment=SSH_AUTH_SOCK=/home/alice/.clanky/worker-ssh-agent/agent.sock",
    );
  });

  test("propagates relay-only mode to the worker service command", () => {
    const unit = renderSystemdUnit({
      ...configuration("linux"),
      relayOnly: true,
      host: "127.0.0.1",
      port: 0,
      environment: {
        ...configuration("linux").environment,
        CLANKY_HOST: "127.0.0.1",
        CLANKY_PORT: "0",
      },
    });
    expect(unit).toContain("--mesh-worker true --relay-only true");
    expect(unit).toContain("Environment=CLANKY_HOST=127.0.0.1");
    expect(unit).toContain("Environment=CLANKY_PORT=0");
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
  test("detects the supported operating systems", () => {
    expect(detectWorkerServicePlatform("darwin")).toBe("darwin");
    expect(detectWorkerServicePlatform("linux")).toBe("linux");
    expect(detectWorkerServicePlatform("win32")).toBe("win32");
    expect(() => detectWorkerServicePlatform("freebsd")).toThrow(
      "supported on macOS, Linux, and Windows",
    );
  });

  test("recognizes standalone Bun binaries but not source entrypoints", () => {
    expect(
      isStandaloneClankyInvocation(
        "/$bunfs/root/index.ts",
        "/usr/local/bin/clanky",
      ),
    ).toBe(true);
    expect(
      isStandaloneClankyInvocation(
        "B:/~BUN/root/clanky-windows-x64",
        "C:\\Users\\alice\\.local\\bin\\clanky.exe",
      ),
    ).toBe(true);
    expect(
      isStandaloneClankyInvocation(
        "/usr/local/bin/clanky",
        "/usr/local/bin/clanky",
      ),
    ).toBe(true);
    expect(
      isStandaloneClankyInvocation(
        "/workspace/src/index.ts",
        "/usr/local/bin/bun",
      ),
    ).toBe(false);
  });

  test("maps workgroup and local-computer accounts to the SCM local domain", () => {
    expect(
      resolveWindowsServiceUserDomain({
        USERDOMAIN: "WORKGROUP",
        COMPUTERNAME: "WIN11VM",
      }),
    ).toBe(".");
    expect(
      resolveWindowsServiceUserDomain({
        USERDOMAIN: "WIN11VM",
        COMPUTERNAME: "WIN11VM",
      }),
    ).toBe(".");
    expect(
      resolveWindowsServiceUserDomain({
        USERDOMAIN: "CORPORATE",
        COMPUTERNAME: "WIN11VM",
      }),
    ).toBe("CORPORATE");
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
      "ExecStart=/home/alice/.local/bin/clanky serve --mesh-worker true --relay-only false --worker-directory /srv/workspaces --worker-execution-enabled true --insecure false",
    );
    expect(unit).toContain("CLANKY_DATA_DIR=/home/alice/.clanky");
    expect(unit).not.toContain('"');
    expect(unit).not.toContain("CLANKY_API_KEY");
  });

  test("renders a credential-free Windows service with a managed binary and quoted paths", () => {
    const xml = renderWindowsService(configuration("win32"));
    expect(xml).toContain("<id>clanky-worker</id>");
    expect(xml).toContain("<startmode>Automatic</startmode>");
    expect(xml).toContain("<delayedAutoStart/>");
    expect(xml).toContain('<onfailure action="restart" delay="5 sec"/>');
    expect(xml).toContain(
      "<executable>C:\\Users\\alice\\.clanky\\worker-service\\clanky-worker.exe</executable>",
    );
    expect(xml).toContain(
      "<arguments>serve --mesh-worker true --relay-only false --worker-directory &quot;C:\\Work Spaces&quot;",
    );
    expect(xml).toContain("<domain>WORKSTATION</domain>");
    expect(xml).toContain("<user>alice</user>");
    expect(xml).not.toContain("<password>");
    expect(xml).not.toContain("CLANKY_API_KEY");
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
      'ExecStart="/home/alice/bin/clanky worker" serve --mesh-worker true --relay-only false --worker-directory "/srv/worker spaces" --worker-execution-enabled true --insecure false',
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
      'ExecStart="/home/alice/bin/$$clanky`worker" serve --mesh-worker true --relay-only false --worker-directory "/srv/$$clanky`workspace" --worker-execution-enabled true --insecure false',
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
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "clanky-worker-status-"),
    );
    const calls: string[][] = [];
    try {
      const paths = {
        ...getWorkerServicePaths("linux", "/home/alice"),
        servicePath: join(temporaryDirectory, "missing.service"),
      };
      const status = await getWorkerServiceStatus(
        paths,
        async (_command, args) => {
          calls.push([...args]);
          if (args[1] === "is-active") {
            return { exitCode: 4, stdout: "inactive\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "not-found\n", stderr: "" };
        },
      );
      expect(status).toMatchObject({
        installed: false,
        loaded: false,
        running: false,
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

describe("macOS worker service lifecycle", () => {
  // launchctl sequencing is the external lifecycle contract that prevents duplicate workers.
  function runnerWith(
    results: WorkerServiceProcessResult[],
  ): {
    calls: Array<{ command: string; args: readonly string[] }>;
    runner: (
      command: string,
      args: readonly string[],
    ) => Promise<WorkerServiceProcessResult>;
  } {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    return {
      calls,
      runner: async (command, args) => {
        calls.push({ command, args });
        const result = results.shift();
        if (!result) {
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        }
        return result;
      },
    };
  }

  const success: WorkerServiceProcessResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  const unloaded: WorkerServiceProcessResult = {
    exitCode: 113,
    stdout: "",
    stderr: "Could not find service",
  };

  test("bootstraps an unloaded RunAtLoad service without kickstarting it", async () => {
    const mock = runnerWith([unloaded, success]);
    const paths = configuration("darwin").paths;

    await runMacWorkerServiceOperation("start", paths, mock.runner);

    expect(mock.calls).toEqual([
      {
        command: "launchctl",
        args: ["print", paths.supervisorTarget],
      },
      {
        command: "launchctl",
        args: ["bootstrap", paths.supervisorDomain!, paths.servicePath],
      },
    ]);
  });

  test("kickstarts a loaded stopped service without forced replacement", async () => {
    const mock = runnerWith([
      { exitCode: 0, stdout: "state = waiting\n", stderr: "" },
      success,
    ]);
    const paths = configuration("darwin").paths;

    await runMacWorkerServiceOperation("start", paths, mock.runner);

    expect(mock.calls.at(-1)).toEqual({
      command: "launchctl",
      args: ["kickstart", paths.supervisorTarget],
    });
  });

  test("leaves an already running service unchanged", async () => {
    const mock = runnerWith([
      { exitCode: 0, stdout: "state = running\n", stderr: "" },
    ]);
    const paths = configuration("darwin").paths;

    await runMacWorkerServiceOperation("start", paths, mock.runner);

    expect(mock.calls).toHaveLength(1);
  });

  test("restarts with bootout followed by one RunAtLoad bootstrap", async () => {
    const mock = runnerWith([
      { exitCode: 0, stdout: "state = running\n", stderr: "" },
      success,
      unloaded,
      success,
    ]);
    const paths = configuration("darwin").paths;

    await runMacWorkerServiceOperation("restart", paths, mock.runner);

    expect(mock.calls).toEqual([
      {
        command: "launchctl",
        args: ["print", paths.supervisorTarget],
      },
      {
        command: "launchctl",
        args: ["bootout", paths.supervisorTarget],
      },
      {
        command: "launchctl",
        args: ["print", paths.supervisorTarget],
      },
      {
        command: "launchctl",
        args: ["bootstrap", paths.supervisorDomain!, paths.servicePath],
      },
    ]);
  });
});

describe("Windows worker service lifecycle", () => {
  function windowsPaths(root: string): WindowsWorkerServicePaths {
    const serviceDirectory = join(root, "worker-service");
    return {
      platform: "win32",
      label: "clanky-worker",
      servicePath: join(serviceDirectory, "clanky-worker-service.xml"),
      supervisorTarget: "clanky-worker",
      serviceDirectory,
      managedBinaryPath: join(serviceDirectory, "clanky-worker.exe"),
      wrapperPath: join(serviceDirectory, "clanky-worker-service.exe"),
    };
  }

  test("deploys, upgrades, and removes service artifacts without deleting worker data", async () => {
    const root = await mkdtemp(join(tmpdir(), "clanky-windows-service-"));
    const paths = windowsPaths(root);
    const sourceBinaryPath = join(root, "installed-clanky.exe");
    const sourceWrapperPath = join(root, "WinSW-x64.exe");
    const dataDir = join(root, "data");
    const persistedDataPath = join(dataDir, "clanky.db");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    let serviceState: "missing" | "stopped" | "running" = "missing";
    const runner = async (
      command: string,
      args: readonly string[],
    ): Promise<WorkerServiceProcessResult> => {
      calls.push({ command, args });
      if (command.endsWith("powershell.exe")) {
        return serviceState === "missing"
          ? { exitCode: 0, stdout: '{"installed":false}', stderr: "" }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                installed: true,
                state: serviceState === "running" ? "Running" : "Stopped",
                processId: serviceState === "running" ? 123 : 0,
                childRunning: serviceState === "running",
              }),
              stderr: "",
            };
      }
      if (args[0] === "install") {
        serviceState = "stopped";
      } else if (args[0] === "start") {
        serviceState = "running";
      } else if (args[0] === "stop") {
        serviceState = "stopped";
      } else if (args[0] === "uninstall") {
        serviceState = "missing";
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const definition: WindowsWorkerServiceDefinition = {
      paths,
      sourceBinaryPath,
      sourceWrapperPath,
      dataDir,
      workerDirectory: "C:\\Work Spaces",
      userName: "alice",
      userDomain: "WORKSTATION",
      environment: {
        CLANKY_DATA_DIR: "C:\\Users\\alice\\.clanky",
        HOME: "C:\\Users\\alice",
      },
      arguments: ["serve", "--worker-directory", "C:\\Work Spaces"],
    };

    try {
      await writeFile(sourceBinaryPath, "version-one");
      await writeFile(sourceWrapperPath, "winsw");
      await mkdir(dataDir, { recursive: true });
      await writeFile(persistedDataPath, "worker-data");

      await installWindowsWorkerService(definition, false, runner);
      expect(await readFile(paths.managedBinaryPath, "utf8")).toBe(
        "version-one",
      );
      expect(await readFile(paths.wrapperPath, "utf8")).toBe("winsw");
      expect(await readFile(paths.servicePath, "utf8")).toContain(
        "<arguments>serve --worker-directory &quot;C:\\Work Spaces&quot;</arguments>",
      );
      expect(
        calls.filter(({ command }) => command.endsWith("powershell.exe")),
      ).toHaveLength(3);
      expect(
        calls
          .filter(({ command }) => !command.endsWith("powershell.exe"))
          .map(({ command, args }) => [command, ...args]),
      ).toEqual([
        [paths.wrapperPath, "install", "/p"],
        [paths.wrapperPath, "start"],
      ]);

      calls.length = 0;
      serviceState = "running";
      await writeFile(sourceBinaryPath, "version-two");
      await installWindowsWorkerService(definition, false, runner);
      expect(await readFile(paths.managedBinaryPath, "utf8")).toBe(
        "version-two",
      );
      expect(
        calls.filter(({ command }) => command.endsWith("powershell.exe")),
      ).toHaveLength(4);
      expect(
        calls
          .filter(({ command }) => !command.endsWith("powershell.exe"))
          .map(({ command, args }) => [command, ...args]),
      ).toEqual([
        [paths.wrapperPath, "stop"],
        [paths.wrapperPath, "start"],
      ]);

      calls.length = 0;
      expect(await getWindowsWorkerServiceStatus(paths, runner)).toMatchObject({
        platform: "win32",
        installed: true,
        loaded: true,
        running: true,
        state: 4,
        childRunning: true,
        processId: 123,
      });

      calls.length = 0;
      await uninstallWindowsWorkerService(paths, runner);
      expect(await Bun.file(paths.managedBinaryPath).exists()).toBe(false);
      expect(await Bun.file(paths.wrapperPath).exists()).toBe(false);
      expect(await Bun.file(paths.servicePath).exists()).toBe(false);
      expect(await readFile(persistedDataPath, "utf8")).toBe("worker-data");
      expect(
        calls.filter(({ command }) => command.endsWith("powershell.exe")),
      ).toHaveLength(2);
      expect(
        calls
          .filter(({ command }) => !command.endsWith("powershell.exe"))
          .map(({ command, args }) => [command, ...args]),
      ).toEqual([
        [paths.wrapperPath, "stop"],
        [paths.wrapperPath, "uninstall"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("makes already-satisfied lifecycle operations idempotent", async () => {
    const paths = windowsPaths("C:\\Users\\alice\\.clanky");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const running = async (
      command: string,
      args: readonly string[],
    ): Promise<WorkerServiceProcessResult> => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: true,
          state: "Running",
          processId: 123,
          childRunning: true,
        }),
        stderr: "",
      };
    };
    await runWindowsWorkerServiceOperation("start", paths, running);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    const stopped = async (
      command: string,
      args: readonly string[],
    ): Promise<WorkerServiceProcessResult> => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: true,
          state: "Stopped",
          processId: 0,
          childRunning: false,
        }),
        stderr: "",
      };
    };
    await runWindowsWorkerServiceOperation("stop", paths, stopped);
    expect(calls).toHaveLength(1);
  });

  test("waits for the managed child when SCM is already running", async () => {
    const paths = windowsPaths("C:\\Users\\alice\\.clanky");
    let inspectionCount = 0;
    const runner = async (
      command: string,
      _args: readonly string[],
    ): Promise<WorkerServiceProcessResult> => {
      expect(command.endsWith("powershell.exe")).toBe(true);
      inspectionCount += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: true,
          state: "Running",
          processId: 123,
          childRunning: inspectionCount > 1,
        }),
        stderr: "",
      };
    };

    await runWindowsWorkerServiceOperation("start", paths, runner);

    expect(inspectionCount).toBe(2);
  });
});
