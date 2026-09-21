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
  getWorkerServicePaths,
  getWorkerServiceStatus,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsService,
  type WorkerServiceConfiguration,
  type WorkerServiceProcessResult,
} from "../../src/cli/worker-service";
import {
  getWindowsWorkerServiceStatus,
  installWindowsWorkerService,
  uninstallWindowsWorkerService,
  type WindowsWorkerServiceDefinition,
  type WindowsWorkerServicePaths,
} from "../../src/cli/worker-service-windows";
import {
  getWorkerSshAgentPaths,
  renderSshAgentRelayServiceUnit,
  renderSshAgentRelaySocketUnit,
  renderSshAgentSystemdUnit,
  unlockWorkerSshAgent,
  type WorkerSshAgentConfiguration,
} from "../../src/cli/worker-ssh-agent";

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

describe("worker SSH-agent service", () => {
  test("renders secret-free systemd agent, relay, and worker integration", () => {
    const agent = sshAgentConfiguration();
    const agentUnit = renderSshAgentSystemdUnit(agent);
    const socketUnit = renderSshAgentRelaySocketUnit(agent);
    const relayUnit = renderSshAgentRelayServiceUnit(agent);
    const workerUnit = renderSystemdUnit(configuration("linux"));

    expect(agentUnit).toContain("User=alice");
    expect(agentUnit).toContain(
      "ExecStart=/usr/bin/ssh-agent -D -a /home/alice/.clanky/worker-ssh-agent/agent-upstream.sock",
    );
    expect(agentUnit).not.toContain("ssh-add");
    expect(agentUnit).not.toContain("passphrase");
    expect(agentUnit).not.toContain("id_ed25519");
    expect(socketUnit).toContain(
      "ListenStream=/home/alice/.clanky/worker-ssh-agent/agent.sock",
    );
    expect(socketUnit).toContain("SocketMode=0600");
    expect(relayUnit).toContain(
      "ExecStart=/home/alice/.local/bin/clanky worker ssh-agent relay",
    );
    expect(workerUnit).toContain(
      "Environment=SSH_AUTH_SOCK=/home/alice/.clanky/worker-ssh-agent/agent.sock",
    );

    const escapedUnit = renderSshAgentSystemdUnit({
      ...agent,
      sshAgentPath: "/usr/bin/ssh$agent",
      paths: {
        ...agent.paths,
        upstreamSocketPath: "/run/$agent.sock",
      },
    });
    expect(escapedUnit).toContain(
      'ExecStart="/usr/bin/ssh$$agent" -D -a "/run/$$agent.sock"',
    );
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
      const agent = {
        ...sshAgentConfiguration(),
        homeDirectory,
        paths: getWorkerSshAgentPaths(homeDirectory),
        sshAddPath,
      };
      await expect(unlockWorkerSshAgent(agent)).resolves.toEqual({
        changed: true,
        identities: 1,
      });
      await expect(unlockWorkerSshAgent(agent)).resolves.toEqual({
        changed: false,
        identities: 1,
      });
      expect(await readFile(join(homeDirectory, ".fake-agent-unlocked"), "utf8"))
        .toBe("loaded\n");
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});

describe("worker service definitions", () => {
  test("renders credential-free service definitions for every supported platform", () => {
    const launchAgent = renderLaunchAgent(configuration("darwin"));
    const systemdUnit = renderSystemdUnit({
      ...configuration("linux"),
      relayOnly: true,
      port: 0,
    });
    const windowsService = renderWindowsService(configuration("win32"));

    expect(launchAgent).toContain("<string>/bin/zsh</string>");
    expect(launchAgent).toContain("<string>-lic</string>");
    expect(systemdUnit).toContain("Restart=on-failure");
    expect(systemdUnit).toContain("--mesh-worker true --relay-only true");
    expect(windowsService).toContain("<startmode>Automatic</startmode>");
    expect(windowsService).toContain(
      "<executable>C:\\Users\\alice\\.clanky\\worker-service\\clanky-worker.exe</executable>",
    );
    for (const definition of [launchAgent, systemdUnit, windowsService]) {
      expect(definition).not.toContain("CLANKY_API_KEY");
      expect(definition).not.toContain("<password>");
    }
  });

  test("escapes systemd executable, working-directory, and environment values", () => {
    const base = configuration("linux");
    const unit = renderSystemdUnit({
      ...base,
      binaryPath: "/home/alice/bin/$clanky` worker",
      workerDirectory: "/srv/$clanky` workspace",
      environment: {
        ...base.environment,
        CLANKY_PUBLIC_BASE_URL: "https://$host.example/path value",
      },
    });

    expect(unit).toContain('WorkingDirectory="/srv/$clanky` workspace"');
    expect(unit).toContain(
      'ExecStart="/home/alice/bin/$$clanky` worker" serve --mesh-worker true --relay-only false --worker-directory "/srv/$$clanky` workspace"',
    );
    expect(unit).toContain(
      'Environment="CLANKY_PUBLIC_BASE_URL=https://$host.example/path value"',
    );
  });

  test("queries service managers even when definition files are missing", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "clanky-worker-status-"));
    try {
      const launchdStatus = await getWorkerServiceStatus({
        ...getWorkerServicePaths("darwin", "/Users/alice", 501),
        servicePath: join(temporaryDirectory, "missing.plist"),
      }, async () => ({
        exitCode: 0,
        stdout: "state = running\n",
        stderr: "",
      }));
      expect(launchdStatus).toMatchObject({
        installed: false,
        loaded: true,
        running: true,
      });

      const systemdStatus = await getWorkerServiceStatus({
        ...getWorkerServicePaths("linux", "/home/alice"),
        servicePath: join(temporaryDirectory, "missing.service"),
      }, async (_command, args) => {
        if (args[1] === "is-active") {
          return { exitCode: 4, stdout: "inactive\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "not-found\n", stderr: "" };
      });
      expect(systemdStatus).toMatchObject({
        installed: false,
        loaded: false,
        running: false,
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
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

  test("deploys, upgrades, and removes artifacts without deleting worker data", async () => {
    const root = await mkdtemp(join(tmpdir(), "clanky-windows-service-"));
    const paths = windowsPaths(root);
    const sourceBinaryPath = join(root, "installed-clanky.exe");
    const sourceWrapperPath = join(root, "WinSW-x64.exe");
    const dataDir = join(root, "data");
    const persistedDataPath = join(dataDir, "clanky.db");
    let serviceState: "missing" | "stopped" | "running" = "missing";
    const runner = async (
      command: string,
      args: readonly string[],
      _options?: { inheritOutput?: boolean },
    ): Promise<WorkerServiceProcessResult> => {
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
      expect(await readFile(paths.managedBinaryPath, "utf8")).toBe("version-one");
      expect(await readFile(paths.wrapperPath, "utf8")).toBe("winsw");

      serviceState = "running";
      await writeFile(sourceBinaryPath, "version-two");
      await installWindowsWorkerService(definition, false, runner);
      expect(await readFile(paths.managedBinaryPath, "utf8")).toBe("version-two");
      expect(await getWindowsWorkerServiceStatus(paths, runner)).toMatchObject({
        platform: "win32",
        installed: true,
        loaded: true,
        running: true,
        state: 4,
        childRunning: true,
        processId: 123,
      });

      await uninstallWindowsWorkerService(paths, runner);
      expect(await Bun.file(paths.managedBinaryPath).exists()).toBe(false);
      expect(await Bun.file(paths.wrapperPath).exists()).toBe(false);
      expect(await Bun.file(paths.servicePath).exists()).toBe(false);
      expect(await readFile(persistedDataPath, "utf8")).toBe("worker-data");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
