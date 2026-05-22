import { EventEmitter } from "node:events";
import { constants, publicEncrypt } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { backendManager } from "../../src/core/backend-manager";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import { initializeDatabase, closeDatabase } from "../../src/persistence/database";
import { saveSshSession } from "../../src/persistence/ssh-sessions";
import { createWorkspace } from "../../src/persistence/workspaces";
import { sshCredentialManager } from "../../src/core/ssh-credential-manager";
import { sshServerKeyManager } from "../../src/core/ssh-server-key-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import type { SshSession, Workspace } from "../../src/types";

class MockStream extends EventEmitter {
  setEncoding() {}
}

class MockChildProcess extends EventEmitter {
  stdout = new MockStream();
  stderr = new MockStream();
  stdin = {
    writable: true,
    write: (_data: string) => true,
  };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoCloseOnKill = true;
  killedSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedSignals.push(signal);
    if (this.autoCloseOnKill) {
      this.emitClose(null, signal);
    }
    return true;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

class ExecutorStub implements CommandExecutor {
  constructor(
    private readonly execImpl: (
      command: string,
      args: string[],
      options?: CommandOptions,
    ) => Promise<CommandResult>,
  ) {}

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    return await this.execImpl(command, args, options);
  }

  async fileExists(): Promise<boolean> {
    return false;
  }

  async directoryExists(): Promise<boolean> {
    return false;
  }

  async readFile(): Promise<string | null> {
    return null;
  }

  async listDirectory(): Promise<string[]> {
    return [];
  }

  async writeFile(): Promise<boolean> {
    return false;
  }
}

const actualChildProcessModule = await import("node:child_process");

let currentProc: MockChildProcess | null = null;
let spawnCount = 0;
let lastSpawnCommand: string[] | null = null;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
mock.module("node:child_process", () => ({
  ...actualChildProcessModule,
  spawn: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    spawnCount += 1;
    lastSpawnCommand = [command, ...args];
    lastSpawnEnv = options?.env;
    currentProc = new MockChildProcess();
    return currentProc as unknown as ReturnType<typeof actualChildProcessModule.spawn>;
  },
}));

const { buildDirectShellCommand } = await import("../../src/core/ssh-bridge/command-builders");
const { buildAttachCommand, SshTerminalBridge } = await import("../../src/core/ssh-terminal-bridge");

function createTestWorkspace(directory: string): Workspace {
  return {
    id: "workspace-1",
    name: "SSH Workspace",
    directory,
    serverSettings: {
      agent: {
        provider: "copilot",
        transport: "ssh",
        hostname: "localhost",
        username: "tester",
        port: 22,
      },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createTestSession(workspaceId: string, directory: string): SshSession {
  return {
    config: {
      id: "ssh-session-1",
      name: "SSH Session",
      workspaceId,
      directory,
      connectionMode: "dtach",
      useTmux: true,
      remoteSessionName: "clanky-session-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    state: {
      status: "ready",
    },
  };
}

async function issueStandaloneCredentialToken(serverId: string, password = "secret"): Promise<string> {
  const publicKey = await sshServerKeyManager.ensurePublicKey(serverId);
  const ciphertext = publicEncrypt({
    key: publicKey.publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  }, Buffer.from(password, "utf8")).toString("base64");
  const exchange = await sshCredentialManager.issueToken(serverId, {
    algorithm: publicKey.algorithm,
    fingerprint: publicKey.fingerprint,
    version: publicKey.version,
    ciphertext,
  });
  return exchange.credentialToken;
}

describe("SshTerminalBridge", () => {
  let tempDir: string;
  let workspace: Workspace;
  let session: SshSession;
  let execImpl: (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clanky-ssh-bridge-unit-"));
    process.env["CLANKY_DATA_DIR"] = tempDir;
    await initializeDatabase();

    backendManager.resetForTesting();
    backendManager.enableTestMode();

    spawnCount = 0;
    currentProc = null;
    lastSpawnCommand = null;
    lastSpawnEnv = undefined;
    workspace = createTestWorkspace("/workspaces/example");
    session = createTestSession(workspace.id, workspace.directory);
    await createWorkspace(workspace);
    await saveSshSession(session);

    execImpl = async (command: string, args: string[]) => {
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
        return {
          success: true,
          stdout: "dtach - version 0.9\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    };
    backendManager.setExecutorFactoryForTesting(() => new ExecutorStub(execImpl));
    sshServerManager.setExecutorFactoryForTesting(() => new ExecutorStub(execImpl));
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    sshServerManager.setExecutorFactoryForTesting(null);
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(tempDir, { recursive: true, force: true });
  });

  test("buildAttachCommand keeps the dtach wrapper around the tmux-aware persistent shell bootstrap", () => {
    const command = buildAttachCommand(session);

    expect(command).toContain("session_socket='/tmp/clanky-session-1.dtach.sock'");
    expect(command).toContain("client_tty_file='/tmp/clanky-terminal-ssh-session-1.tty'");
    expect(command).toContain("session_tty_file='/tmp/clanky-terminal-ssh-session-1.session.tty'");
    expect(command).toMatch(/cd .*\/workspaces\/example.*\|\| exit 1;/);
    expect(command).toMatch(/COLORTERM=.*truecolor.*;/);
    expect(command).toContain("export COLORTERM;");
    expect(command).toContain("dtach -N \"$session_socket\" -Ez bash -lc");
    expect(command).toContain("dtach -a \"$session_socket\" -E -z -r winch");
    expect(command).toContain("tmux new-session \\; set-option destroy-unattached on;");
  });

  test("buildAttachCommand omits the working directory for standalone sessions", () => {
    const command = buildAttachCommand({
      config: {
        id: "standalone-session-1",
        remoteSessionName: "clanky-server-session-1",
      },
    });

    expect(command).toContain("session_socket='/tmp/clanky-server-session-1.dtach.sock'");
    expect(command).not.toContain("cd '");
  });

  test("buildDirectShellCommand tries preferred and simpler tmux startup paths", () => {
    const command = buildDirectShellCommand({
      config: {
        id: "direct-session-1",
        directory: "/workspaces/example",
      },
    });
    const preferredTmuxIndex = command.indexOf("tmux new-session \\; set-option destroy-unattached on;");
    const simplerTmuxIndex = command.indexOf("tmux new-session;");
    const shellFallbackIndex = command.indexOf("exec \"$shell\" -i");

    expect(command).toMatch(/cd .*\/workspaces\/example.*\|\| exit 1;/);
    expect(command).toContain("if command -v tmux >/dev/null 2>&1; then");
    expect(preferredTmuxIndex).toBeGreaterThan(-1);
    expect(simplerTmuxIndex).toBeGreaterThan(preferredTmuxIndex);
    expect(shellFallbackIndex).toBeGreaterThan(simplerTmuxIndex);
  });

  test("buildDirectShellCommand keeps the interactive shell fallback when tmux is unavailable or cannot start", () => {
    const command = buildDirectShellCommand({
      config: {
        id: "direct-session-2",
      },
    });

    expect(command).toContain("shell=\"${SHELL:-/bin/sh}\";");
    expect(command).toContain("tmux_status=$?;");
    expect(command).toContain("exec \"$shell\" -i");
  });

  test("buildDirectShellCommand skips tmux startup when the session disables it", () => {
    const command = buildDirectShellCommand({
      config: {
        id: "direct-session-3",
        useTmux: false,
      },
    });

    expect(command).not.toContain("if command -v tmux >/dev/null 2>&1; then");
    expect(command).not.toContain("tmux new-session");
    expect(command).toContain("exec \"$shell\" -i");
  });

  test("uses a fallback TERM when the server environment does not define one", async () => {
    const previousTerm = process.env["TERM"];
    const previousColorTerm = process.env["COLORTERM"];
    delete process.env["TERM"];
    delete process.env["COLORTERM"];

    try {
      const bridge = new SshTerminalBridge(session.config.id, {
        onOutput: () => {},
      });

      await bridge.connect();

      expect(lastSpawnCommand?.[0]).toBe("ssh");
      expect(lastSpawnEnv?.["TERM"]).toBe("xterm-256color");
      expect(lastSpawnEnv?.["COLORTERM"]).toBe("truecolor");

      await bridge.dispose();
    } finally {
      if (previousTerm === undefined) {
        delete process.env["TERM"];
      } else {
        process.env["TERM"] = previousTerm;
      }
      if (previousColorTerm === undefined) {
        delete process.env["COLORTERM"];
      } else {
        process.env["COLORTERM"] = previousColorTerm;
      }
    }
  });

  test("preserves an existing TERM when opening the SSH terminal", async () => {
    const previousTerm = process.env["TERM"];
    const previousColorTerm = process.env["COLORTERM"];
    process.env["TERM"] = "screen-256color";
    delete process.env["COLORTERM"];

    try {
      const bridge = new SshTerminalBridge(session.config.id, {
        onOutput: () => {},
      });

      await bridge.connect();

      expect(lastSpawnCommand?.[0]).toBe("ssh");
      expect(lastSpawnEnv?.["TERM"]).toBe("screen-256color");
      expect(lastSpawnEnv?.["COLORTERM"]).toBe("truecolor");

      await bridge.dispose();
    } finally {
      if (previousTerm === undefined) {
        delete process.env["TERM"];
      } else {
        process.env["TERM"] = previousTerm;
      }
      if (previousColorTerm === undefined) {
        delete process.env["COLORTERM"];
      } else {
        process.env["COLORTERM"] = previousColorTerm;
      }
    }
  });

  test("marks startup probe failures as failed and tears down the SSH process", async () => {
    execImpl = async (command: string, args: string[]) => {
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
        return {
          success: true,
          stdout: "dtach - version 0.9\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error("persistent session probe failed");
    };

    const onErrorCalls: string[] = [];
    const bridge = new SshTerminalBridge(session.config.id, {
      onOutput: () => {},
      onError: (error) => {
        onErrorCalls.push(String(error));
      },
    });

    await expect(bridge.connect()).rejects.toThrow("persistent session probe failed");

    expect(currentProc?.killedSignals).toEqual(["SIGTERM"]);
    expect(onErrorCalls.some((message) => message.includes("persistent session probe failed"))).toBe(true);
  });

  test("allows readiness probes to use the remaining session timeout budget", async () => {
    const readyProbeTimeouts: number[] = [];
    execImpl = async (command: string, args: string[], options?: CommandOptions) => {
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
        return {
          success: true,
          stdout: "dtach - version 0.9\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("session_socket=")) {
        readyProbeTimeouts.push(options?.timeout ?? 0);
        if ((options?.timeout ?? 0) >= 1_500) {
          return {
            success: true,
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          success: false,
          stdout: "",
          stderr: `Command timed out after ${options?.timeout ?? 0}ms`,
          exitCode: 124,
        };
      }
      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    };

    const bridge = new SshTerminalBridge(session.config.id, {
      onOutput: () => {},
      readyTimeoutMs: 2_000,
    });

    await bridge.connect();

    expect(readyProbeTimeouts.length).toBeGreaterThan(0);
    expect(readyProbeTimeouts[0]).toBeGreaterThanOrEqual(1_500);

    await bridge.dispose();
  });

  test("clamps readiness probes to the remaining deadline budget", async () => {
    const readyProbeTimeouts: number[] = [];
    const originalDateNow = Date.now;
    (Date as { now: typeof Date.now }).now = () => 0;

    execImpl = async (command: string, args: string[], options?: CommandOptions) => {
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
        return {
          success: true,
          stdout: "dtach - version 0.9\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command === "bash" && args[0] === "-lc" && args[1]?.includes("session_socket=")) {
        readyProbeTimeouts.push(options?.timeout ?? 0);
        return {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    };

    try {
      const bridge = new SshTerminalBridge(session.config.id, {
        onOutput: () => {},
        readyTimeoutMs: 50,
      });

      await bridge.connect();

      expect(readyProbeTimeouts).toEqual([50]);

      await bridge.dispose();
    } finally {
      (Date as { now: typeof Date.now }).now = originalDateNow;
    }
  });

  test("dispose waits for close and allows reconnecting the same bridge instance", async () => {
    const bridge = new SshTerminalBridge(session.config.id, {
      onOutput: () => {},
    });

    await bridge.connect();
    expect(spawnCount).toBe(1);

    const firstProc = currentProc!;
    firstProc.autoCloseOnKill = false;

    let disposed = false;
    const disposePromise = bridge.dispose().then(() => {
      disposed = true;
    });

    await Bun.sleep(0);
    expect(disposed).toBe(false);
    expect(firstProc.killedSignals).toEqual(["SIGTERM"]);

    firstProc.emitClose(0, "SIGTERM");
    await disposePromise;
    expect(disposed).toBe(true);

    await bridge.connect();
    expect(spawnCount).toBe(2);
  });

  test("extracts OSC 52 clipboard copies from terminal output", async () => {
    const outputChunks: string[] = [];
    const clipboardCopies: string[] = [];
    const bridge = new SshTerminalBridge(session.config.id, {
      onOutput: (chunk) => {
        outputChunks.push(chunk);
      },
      onClipboardCopy: (text) => {
        clipboardCopies.push(text);
      },
    });

    await bridge.connect();

    currentProc?.stdout.emit("data", `before ${"\u001b]52;c;Y29waWVkIHRleHQ=\u0007"} after`);

    expect(outputChunks).toContain("before  after");
    expect(clipboardCopies).toEqual(["copied text"]);
  });

  test("buffers split OSC 52 clipboard sequences until the terminator arrives", async () => {
    const outputChunks: string[] = [];
    const clipboardCopies: string[] = [];
    const bridge = new SshTerminalBridge(session.config.id, {
      onOutput: (chunk) => {
        outputChunks.push(chunk);
      },
      onClipboardCopy: (text) => {
        clipboardCopies.push(text);
      },
    });

    await bridge.connect();

    currentProc?.stdout.emit("data", "before ");
    currentProc?.stdout.emit("data", "\u001b]52;c;Y29w");
    currentProc?.stdout.emit("data", "aWVkIHRleHQ=\u0007 after");

    expect(outputChunks).toEqual(["before ", " after"]);
    expect(clipboardCopies).toEqual(["copied text"]);
  });

  test("flushes oversized unterminated OSC 52 buffers as raw output", async () => {
    const outputChunks: string[] = [];
    const clipboardCopies: string[] = [];
    const bridge = new SshTerminalBridge(session.config.id, {
      onOutput: (chunk) => {
        outputChunks.push(chunk);
      },
      onClipboardCopy: (text) => {
        clipboardCopies.push(text);
      },
    });

    await bridge.connect();

    const oversizedSequence = "\u001b]52;c;" + "a".repeat(1024 * 1024 + 1);
    currentProc?.stdout.emit("data", oversizedSequence);
    currentProc?.stdout.emit("data", "after");

    expect(outputChunks).toEqual([oversizedSequence, "after"]);
    expect(clipboardCopies).toEqual([]);
  });

  test("connects standalone SSH server sessions with a credential token", async () => {
    const server = await sshServerManager.createServer({
      name: "Shared host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: null,
    });
    const standaloneSession = await sshServerManager.createSession(server.config.id, {
      name: "Deploy shell",
      credentialToken: null,
      connectionMode: "dtach",
    });
    const terminalToken = await issueStandaloneCredentialToken(server.config.id);

    const bridge = new SshTerminalBridge(standaloneSession.config.id, {
      onOutput: () => {},
    }, {
      sessionKind: "standalone",
      credentialToken: terminalToken,
    });

    await bridge.connect();

    expect(lastSpawnCommand?.[0]).toBe("sshpass");
    expect(lastSpawnCommand?.join(" ")).toContain("deploy@ssh.example.com");
    expect(lastSpawnCommand?.join(" ")).not.toContain(" -c ");
    expect(lastSpawnEnv?.["SSHPASS"]).toBe("secret");

    await bridge.dispose();
  });
});
