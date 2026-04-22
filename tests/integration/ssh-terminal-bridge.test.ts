import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "node:net";
import { createWorkspace } from "../../src/persistence/workspaces";
import { initializeDatabase, closeDatabase } from "../../src/persistence/database";
import { saveSshSession } from "../../src/persistence/ssh-sessions";
import { backendManager } from "../../src/core/backend-manager";
import { SshTerminalBridge } from "../../src/core/ssh-terminal-bridge";
import type { SshSession, Workspace } from "../../src/types";

interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  const result = await Bun.$`which ${command}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function runCommand(command: string[], env?: NodeJS.ProcessEnv): Promise<CommandRunResult> {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
  };
}

async function runQuiet(command: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCommand(command, env);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Command failed: ${command.join(" ")}`);
  }
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  failureMessage: () => string,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(failureMessage());
}

const canRunRealSshBridge = async () =>
  process.env["RALPHER_RUN_REAL_SSH_BRIDGE_TEST"] === "1"
  && await commandExists("sshd")
  && await commandExists("ssh")
  && await commandExists("ssh-keygen")
  && await commandExists("dtach");

function startStreamingCapture(stream: ReadableStream<Uint8Array>): { read: () => string; done: Promise<void> } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const done = (async () => {
    while (true) {
      const { done: isDone, value } = await reader.read();
      if (isDone) {
        break;
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
  })();
  return {
    read: () => output,
    done,
  };
}

describe("SshTerminalBridge integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-bridge-"));
    process.env["RALPHER_DATA_DIR"] = join(tempDir, "data");
    backendManager.resetForTesting();
    await initializeDatabase();
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(tempDir, { recursive: true, force: true });
  });

  test("connects through a real local sshd and tears it down when capabilities are available", async () => {
    if (!(await canRunRealSshBridge())) {
      return;
    }

    const homeDir = join(tempDir, "home");
    const sshDir = join(homeDir, ".ssh");
    const serverDir = join(tempDir, "server");
    const workspaceDir = join(tempDir, "workspace");
    await mkdir(sshDir, { recursive: true });
    await mkdir(serverDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    await Bun.$`git init ${workspaceDir}`.quiet();
    await Bun.$`git -C ${workspaceDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workspaceDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${workspaceDir}/README.md`.quiet();
    await Bun.$`git -C ${workspaceDir} add .`.quiet();
    await Bun.$`git -C ${workspaceDir} commit -m "Initial commit"`.quiet();

    await runQuiet(["ssh-keygen", "-q", "-t", "rsa", "-N", "", "-f", join(sshDir, "id_rsa")]);
    const publicKey = await readFile(join(sshDir, "id_rsa.pub"), "utf8");
    await writeFile(join(sshDir, "authorized_keys"), publicKey, { mode: 0o600 });
    await runQuiet(["ssh-keygen", "-q", "-t", "rsa", "-N", "", "-f", join(serverDir, "ssh_host_rsa_key")]);

    const usernameResult = await Bun.$`whoami`.text();
    const username = usernameResult.trim();
    const port = await getAvailablePort();
    const pidFile = join(serverDir, "sshd.pid");
    const configPath = join(serverDir, "sshd_config");
    await writeFile(configPath, [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(serverDir, "ssh_host_rsa_key")}`,
      `PidFile ${pidFile}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "UsePAM no",
      "PermitRootLogin no",
      "PubkeyAuthentication yes",
      `AuthorizedKeysFile ${join(sshDir, "authorized_keys")}`,
      `AllowUsers ${username}`,
      "StrictModes no",
      "Subsystem sftp internal-sftp",
    ].join("\n"));

    const sshd = Bun.spawn(["/usr/sbin/sshd", "-D", "-f", configPath], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const sshdStderr = startStreamingCapture(sshd.stderr);

    try {
      let lastProbe: CommandRunResult | null = null;
      await waitForCondition(
        async () => {
          lastProbe = await runCommand([
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            "IdentitiesOnly=yes",
            "-i",
            join(sshDir, "id_rsa"),
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-p",
            String(port),
            `${username}@127.0.0.1`,
            "--",
            "true",
          ]);
          return lastProbe.exitCode === 0;
        },
        () => {
          const parts = [
            "sshd did not become ready",
            lastProbe?.stderr.trim() ? `probe stderr: ${lastProbe.stderr.trim()}` : "",
            sshdStderr.read().trim() ? `sshd stderr: ${sshdStderr.read().trim()}` : "",
          ].filter((part) => part.length > 0);
          return parts.join("; ");
        },
      );

      const workspace: Workspace = {
        id: crypto.randomUUID(),
        name: "SSH Test Workspace",
        directory: workspaceDir,
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "127.0.0.1",
            port,
            username,
            identityFile: join(sshDir, "id_rsa"),
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await createWorkspace(workspace);

      const session: SshSession = {
        config: {
          id: crypto.randomUUID(),
          name: "Bridge Session",
          workspaceId: workspace.id,
          directory: workspaceDir,
          connectionMode: "dtach",
          useTmux: true,
          remoteSessionName: `ralpher-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        state: {
          status: "ready",
        },
      };
      await saveSshSession(session);

      let output = "";
      const bridge = new SshTerminalBridge(session.config.id, {
        onOutput: (chunk) => {
          output += chunk;
        },
        readyTimeoutMs: 30_000,
      });

      await bridge.connect();
      await bridge.resize(120, 32);
      bridge.sendInput("size=$(stty size); printf 'SSH_BRIDGE_SIZE:%s:DONE\\n' \"$size\"\n");
      bridge.sendInput("echo SSH_BRIDGE_OK\n");

      await waitForCondition(
        async () => output.includes("SSH_BRIDGE_OK") && output.includes("SSH_BRIDGE_SIZE:32 120:DONE"),
        () => `Timed out waiting for SSH terminal output. Last output:\n${output}`,
      );

      expect(output).toContain("SSH_BRIDGE_SIZE:32 120:DONE");
      expect(output).toContain("SSH_BRIDGE_OK");
      await bridge.dispose();
    } finally {
      sshd.kill();
      await sshd.exited;
      await sshdStderr.done;
    }
  }, { timeout: 45_000 });
});
