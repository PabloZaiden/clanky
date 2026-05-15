import { describe, expect, spyOn, test } from "bun:test";

import { log } from "../../src/core/logger";
import { buildSshCommandArgs, buildSshRemoteShellCommand, CommandExecutorImpl } from "../../src/core/remote-command-executor";

function getSshOptionValue(args: string[], optionName: string): string | undefined {
  const prefix = `${optionName}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

describe("CommandExecutorImpl SSH spawn cwd", () => {
  test("builds a shell bootstrap that prefers zsh and falls back to bash/sh", () => {
    const script = buildSshRemoteShellCommand("echo hello");

    expect(script).toContain("sh -lc");
    expect(script).toContain('shell_path="${SHELL:-}"');
    expect(script).toContain('exec "$shell_path" -ilc');
    expect(script).toContain('command -v sh');
  });

  test("uses root cwd for SSH command execution", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCwd: string | undefined;
    let capturedCommand: string[] | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const command = (args.length === 1
        ? (args[0] as { cmd?: string[] } | undefined)?.cmd
        : args[0]) as string[] | undefined;
      const options = (args.length === 1 ? args[0] : args[1]) as { cwd?: string } | undefined;
      capturedCommand = command;
      capturedCwd = options?.cwd;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        provider: "ssh",
        directory: "/workspaces/remote-only-path",
        host: "127.0.0.1",
      });

      const result = await executor.exec("pwd", []);
      expect(result.success).toBe(false);
      expect(capturedCwd).toBe("/");
      expect(capturedCommand).toBeDefined();
      const commandTokens = capturedCommand ?? [];
      expect(commandTokens).toContain("ControlMaster=auto");
      expect(commandTokens).toContain("ControlPersist=60s");
      expect(getSshOptionValue(commandTokens, "ControlPath")).toMatch(/^~\/\.ssh\/ralpher-cm-v1-[a-f0-9]{32}$/);
      const scriptArg = commandTokens[commandTokens.indexOf("--") + 1];
      expect(typeof scriptArg).toBe("string");
      expect(scriptArg ?? "").toContain("sh -lc");
      expect(scriptArg ?? "").toContain('exec "$shell_path" -ilc');
      expect(scriptArg ?? "").toContain("&&");
      expect(result.stderr).toContain("mock spawn failure");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("wraps git commands in bash and sources shell env", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCommand: string[] | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const command = (args.length === 1
        ? (args[0] as { cmd?: string[] } | undefined)?.cmd
        : args[0]) as string[] | undefined;
      capturedCommand = command;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        provider: "ssh",
        directory: "/workspaces/remote-only-path",
        host: "127.0.0.1",
      });

      const result = await executor.exec("git", ["status", "--porcelain"], {
        cwd: "/workspaces/myrepo",
      });
      expect(result.success).toBe(false);

      const commandTokens = capturedCommand ?? [];
      expect(commandTokens).toContain("ControlMaster=auto");
      expect(commandTokens).toContain("ControlPersist=60s");
      const scriptArg = commandTokens[commandTokens.indexOf("--") + 1] ?? "";
      expect(scriptArg).toContain("sh -lc");
      expect(scriptArg).toContain('exec "$shell_path" -ilc');
      expect(scriptArg).toContain("git");
      expect(scriptArg).toContain("status");
      expect(scriptArg).toContain("--porcelain");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("injects per-command environment variables into the remote shell command", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCommand: string[] | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const command = (args.length === 1
        ? (args[0] as { cmd?: string[] } | undefined)?.cmd
        : args[0]) as string[] | undefined;
      capturedCommand = command;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        provider: "ssh",
        directory: "/workspaces/remote-only-path",
        host: "127.0.0.1",
      });

      const result = await executor.exec("git", ["fetch", "origin", "main"], {
        cwd: "/workspaces/myrepo",
        env: {
          GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new",
        },
      });
      expect(result.success).toBe(false);

      const commandTokens = capturedCommand ?? [];
      const scriptArg = commandTokens[commandTokens.indexOf("--") + 1] ?? "";
      expect(scriptArg).toContain("GIT_SSH_COMMAND=");
      expect(scriptArg).toContain("StrictHostKeyChecking=accept-new");
      expect(scriptArg).toContain("fetch");
      expect(scriptArg).toContain("origin");
      expect(scriptArg).toContain("main");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("uses sshpass environment mode for password auth", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCommand: string[] | undefined;
    let capturedEnv: Record<string, string | undefined> | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const command = (args.length === 1
        ? (args[0] as { cmd?: string[] } | undefined)?.cmd
        : args[0]) as string[] | undefined;
      const options = (args.length === 1 ? args[0] : args[1]) as { env?: Record<string, string | undefined> } | undefined;
      capturedCommand = command;
      capturedEnv = options?.env;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        provider: "ssh",
        directory: "/workspaces/remote-only-path",
        host: "127.0.0.1",
        password: "top-secret",
      });

      const result = await executor.exec("pwd", []);
      expect(result.success).toBe(false);

      const commandTokens = capturedCommand ?? [];
      expect(commandTokens[0]).toBe("sshpass");
      expect(commandTokens).toContain("-e");
      const sshIndex = commandTokens.indexOf("ssh");
      expect(sshIndex).toBeGreaterThanOrEqual(0);
      expect(commandTokens).toContain("NumberOfPasswordPrompts=1");
      expect(commandTokens).toContain("PreferredAuthentications=password,keyboard-interactive");
      expect(commandTokens).not.toContain("ControlMaster=auto");
      expect(commandTokens).not.toContain("ControlPersist=60s");
      expect(getSshOptionValue(commandTokens, "ControlPath")).toBeUndefined();
      expect(commandTokens).not.toContain("top-secret");
      expect(capturedEnv?.["SSHPASS"]).toBe("top-secret");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("uses an explicit identity file when configured for SSH auth", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCommand: string[] | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const command = (args.length === 1
        ? (args[0] as { cmd?: string[] } | undefined)?.cmd
        : args[0]) as string[] | undefined;
      capturedCommand = command;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        provider: "ssh",
        directory: "/workspaces/remote-only-path",
        host: "127.0.0.1",
        identityFile: "/tmp/test-key",
      });

      const result = await executor.exec("pwd", []);
      expect(result.success).toBe(false);

      const commandTokens = capturedCommand ?? [];
      expect(commandTokens[0]).toBe("ssh");
      expect(commandTokens).toContain("ControlMaster=auto");
      expect(commandTokens).toContain("ControlPersist=60s");
      expect(commandTokens).toContain("IdentityAgent=none");
      expect(commandTokens).toContain("IdentitiesOnly=yes");
      const identityFileIndex = commandTokens.indexOf("-i");
      expect(identityFileIndex).toBeGreaterThanOrEqual(0);
      expect(commandTokens[identityFileIndex + 1]).toBe("/tmp/test-key");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("builds stable scoped ControlPath values for compatible SSH details", () => {
    const firstArgs = buildSshCommandArgs({
      authMode: "batch",
      port: 22,
      target: "alice@remote.example.com",
      identityFile: "/tmp/test-key",
      connectionScope: "/workspaces/project",
    });
    const secondArgs = buildSshCommandArgs({
      authMode: "batch",
      port: 22,
      target: "alice@remote.example.com",
      identityFile: "/tmp/test-key",
      connectionScope: "/workspaces/project",
    });

    expect(getSshOptionValue(firstArgs, "ControlPath")).toBe(getSshOptionValue(secondArgs, "ControlPath"));
  });

  test("changes ControlPath when reuse-sensitive batch SSH details change", () => {
    const baseArgs = buildSshCommandArgs({
      authMode: "batch",
      port: 22,
      target: "alice@remote.example.com",
      identityFile: "/tmp/test-key",
      connectionScope: "/workspaces/project",
    });
    const changedWorkspaceArgs = buildSshCommandArgs({
      authMode: "batch",
      port: 22,
      target: "alice@remote.example.com",
      identityFile: "/tmp/test-key",
      connectionScope: "/workspaces/other-project",
    });
    const changedIdentityArgs = buildSshCommandArgs({
      authMode: "batch",
      port: 22,
      target: "alice@remote.example.com",
      identityFile: "/tmp/other-key",
      connectionScope: "/workspaces/project",
    });

    const baseControlPath = getSshOptionValue(baseArgs, "ControlPath");
    expect(baseControlPath).toMatch(/^~\/\.ssh\/ralpher-cm-v1-[a-f0-9]{32}$/);
    expect(getSshOptionValue(changedWorkspaceArgs, "ControlPath")).not.toBe(baseControlPath);
    expect(getSshOptionValue(changedIdentityArgs, "ControlPath")).not.toBe(baseControlPath);
  });

  test("does not use SSH multiplexing for password auth", () => {
    const args = buildSshCommandArgs({
      authMode: "password",
      port: 22,
      target: "alice@remote.example.com",
      connectionScope: "/workspaces/project",
    });

    expect(args).toContain("NumberOfPasswordPrompts=1");
    expect(args).toContain("PreferredAuthentications=password,keyboard-interactive");
    expect(args).not.toContain("ControlMaster=auto");
    expect(args).not.toContain("ControlPersist=60s");
    expect(getSshOptionValue(args, "ControlPath")).toBeUndefined();
  });

  test("returns promptly with exit code 130 when local execution is aborted", async () => {
    const originalSpawn = Bun.spawn;
    let killCalled = false;
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          stderrController = controller;
        },
      }),
      exited: new Promise<number>(() => {}),
      kill: () => {
        killCalled = true;
        stdoutController?.close();
        stderrController?.close();
      },
    })) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        directory: "/tmp",
      });
      const controller = new AbortController();
      const execution = executor.exec("sleep", ["30"], {
        signal: controller.signal,
        timeout: 5_000,
      });

      controller.abort();

      const result = await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("Abort did not resolve promptly"));
          }, 500);
        }),
      ]);

      expect(killCalled).toBe(true);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toBe("Command aborted");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("logs failed commands by default", async () => {
    const originalSpawn = Bun.spawn;
    const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        directory: "/tmp",
      });

      const result = await executor.exec("git", ["status"]);

      expect(result.success).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith("[CommandExecutor] Command failed: git status");
      expect(errorSpy).toHaveBeenCalledWith("[CommandExecutor]   exitCode: 1");
      expect(errorSpy).toHaveBeenCalledWith("[CommandExecutor]   stderr: Error: mock spawn failure");
    } finally {
      errorSpy.mockRestore();
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("suppresses failed command logs when logFailures is false", async () => {
    const originalSpawn = Bun.spawn;
    const errorSpy = spyOn(log, "error").mockImplementation(() => undefined);

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    try {
      const executor = new CommandExecutorImpl({
        directory: "/tmp",
      });

      const result = await executor.exec("git", ["status"], {
        logFailures: false,
      });

      expect(result.success).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});
