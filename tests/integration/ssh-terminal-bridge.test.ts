import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "node:net";
import { createWorkspace } from "../../src/persistence/workspaces";
import { initializeDatabase, closeDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { SshTerminalBridge } from "../../src/core/ssh-terminal-bridge";
import { terminalSessionManager } from "../../src/core/terminal-session-manager";
import type { Workspace } from "@/shared";
import { initializeGitRepository } from "../helpers/git-fixtures";
import { pollUntil } from "../helpers/polling";
import { runWithCurrentUser } from "../../src/core/user-context";
import { testOwnerUser } from "../setup";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { loadSshServerKeyPair } from "../../src/persistence/ssh-server-keys";
import { executionHostService } from "../../src/core/execution-host-service";

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
  await pollUntil(
    predicate,
    (ready) => ready,
    {
      description: "SSH bridge condition",
      timeoutMs,
      intervalMs,
      formatLastObserved: () => failureMessage(),
    },
  );
}

const canRunRealSshBridge = async () =>
  process.env["CLANKY_RUN_REAL_SSH_BRIDGE_TEST"] === "1"
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
    tempDir = await mkdtemp(join(tmpdir(), "clanky-ssh-bridge-"));
    process.env["CLANKY_DATA_DIR"] = join(tempDir, "data");
    backendManager.resetForTesting();
    await initializeDatabase();
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
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

    await initializeGitRepository(workspaceDir, { initialCommit: "readme" });

    await runQuiet(["ssh-keygen", "-q", "-t", "rsa", "-N", "", "-f", join(serverDir, "ssh_host_rsa_key")]);

    const usernameResult = await Bun.$`whoami`.text();
    const username = usernameResult.trim();
    const port = await getAvailablePort();
    const sshServer = await runWithCurrentUser(testOwnerUser, async () => {
      const server = await sshServerManager.createServer({
        name: "SSH bridge test server",
        address: "127.0.0.1",
        port,
        username,
        repositoriesBasePath: tempDir,
      });
      const keyPair = await loadSshServerKeyPair(server.config.id);
      if (!keyPair) {
        throw new Error("SSH server key pair was not created");
      }
      const privateKeyPath = join(sshDir, "id_rsa");
      await writeFile(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
      const publicKey = (await runCommand(["ssh-keygen", "-y", "-f", privateKeyPath])).stdout;
      await writeFile(join(sshDir, "authorized_keys"), publicKey, { mode: 0o600 });
      await executionHostService.listHosts();
      return server;
    });
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
        workspaceType: "git",
        executionTargetRevision: 1,
        executionHostBinding: await runWithCurrentUser(testOwnerUser, async () => (
          executionHostService.getBinding({ kind: "ssh", serverId: sshServer.config.id })
        )),
        serverSettings: {
          agent: {
            provider: "opencode",
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await runWithCurrentUser(testOwnerUser, async () => {
        await createWorkspace(workspace);
        const session = await terminalSessionManager.createSession({
          workspaceId: workspace.id,
          name: "Bridge Session",
          connectionMode: "dtach",
          useTmux: true,
        });

        let output = "";
        const bridge = new SshTerminalBridge(session.config.id, {
          onOutput: (chunk) => {
            output += chunk;
          },
          readyTimeoutMs: 30_000,
        }, {});

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
      });
    } finally {
      sshd.kill();
      await sshd.exited;
      await sshdStderr.done;
    }
  }, { timeout: 45_000 });
});
