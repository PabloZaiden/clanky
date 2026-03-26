import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import type { DevboxStatusResult } from "../../src/types";

interface ExecCall {
  command: string;
  args: string[];
  cwd: string;
}

export interface ProvisioningTestExecutorOptions {
  failDevboxVersion?: boolean;
  failClone?: boolean;
  failDevboxUp?: boolean;
  failDevboxRebuild?: boolean;
  failDevboxArise?: boolean;
  devboxUpDelayMs?: number;
  devboxStatusOutput?: string;
  credentialFileContent?: string;
  /** Pre-populate these directories as existing */
  existingDirectories?: string[];
}

async function waitWithSignal(signal: AbortSignal | undefined, durationMs: number): Promise<boolean> {
  if (durationMs <= 0) {
    return signal?.aborted === true;
  }

  const intervalMs = 25;
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    if (signal?.aborted) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return signal?.aborted === true;
}

export function createDevboxStatusOutput(overrides: Partial<DevboxStatusResult> = {}): string {
  return JSON.stringify({
    running: true,
    port: 5005,
    password: "devbox-password",
    workdir: "/workspaces/devbox",
    sshUser: "vscode",
    sshPort: 5005,
    remoteUser: "vscode",
    hasCredentialFile: false,
    credentialPath: null,
    publishedPorts: {
      "5005/tcp": [
        {
          hostIp: "0.0.0.0",
          hostPort: 5005,
        },
      ],
    },
    ...overrides,
  });
}

export class ProvisioningTestExecutor implements CommandExecutor {
  readonly calls: ExecCall[] = [];
  private readonly directories = new Set<string>();
  private readonly gitRepos = new Map<string, { origin: string }>();
  private readonly files = new Map<string, string>();

  constructor(private readonly options: ProvisioningTestExecutorOptions = {}) {
    if (options.credentialFileContent) {
      this.files.set("/tmp/devbox/.sshcred", options.credentialFileContent);
    }
    if (options.existingDirectories) {
      for (const dir of options.existingDirectories) {
        this.directories.add(dir);
      }
    }
  }

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    const cwd = options?.cwd ?? "/";
    this.calls.push({ command, args: [...args], cwd });

    if (options?.signal?.aborted) {
      return {
        success: false,
        stdout: "",
        stderr: "Command aborted",
        exitCode: 130,
      };
    }

    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v devbox")) {
      if (this.options.failDevboxVersion) {
        return {
          success: false,
          stdout: "",
          stderr: "devbox: command not found",
          exitCode: 127,
        };
      }
      const stdout = "/usr/bin/devbox\n";
      return { success: true, stdout, stderr: "", exitCode: 0 };
    }

    if (command === "mkdir" && args[0] === "-p" && args[1]) {
      this.directories.add(args[1]);
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "clone" && args[1] && args[2]) {
      if (this.options.failClone) {
        return {
          success: false,
          stdout: "",
          stderr: "fatal: clone failed",
          exitCode: 1,
        };
      }

      const target = args[2];
      this.directories.add(target);
      this.gitRepos.set(target, { origin: args[1] });
      const stdout = `Cloning into '${target}'...\n`;
      options?.onStdoutChunk?.(stdout);
      return { success: true, stdout, stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      const success = this.gitRepos.has(cwd);
      return {
        success,
        stdout: success ? "true\n" : "",
        stderr: success ? "" : "fatal: not a git repository",
        exitCode: success ? 0 : 128,
      };
    }

    if (command === "git" && args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
      const repo = this.gitRepos.get(cwd);
      if (!repo) {
        return {
          success: false,
          stdout: "",
          stderr: "fatal: No remote configured",
          exitCode: 1,
        };
      }
      return {
        success: true,
        stdout: `${repo.origin}\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    if (command === "devbox" && args[0] === "up") {
      const aborted = await waitWithSignal(options?.signal, this.options.devboxUpDelayMs ?? 0);
      if (aborted) {
        return {
          success: false,
          stdout: "",
          stderr: "Command aborted",
          exitCode: 130,
        };
      }

      const stdout = "Starting devbox...\nDevbox is ready.\n";
      options?.onStdoutChunk?.(stdout);

      if (this.options.failDevboxUp) {
        return {
          success: false,
          stdout,
          stderr: "devbox up failed",
          exitCode: 1,
        };
      }

      return { success: true, stdout, stderr: "", exitCode: 0 };
    }

    if (command === "devbox" && args[0] === "rebuild") {
      const stdout = "Rebuilding devbox...\nDevbox rebuilt and started.\n";
      options?.onStdoutChunk?.(stdout);

      if (this.options.failDevboxRebuild) {
        return {
          success: false,
          stdout,
          stderr: "devbox rebuild failed",
          exitCode: 1,
        };
      }

      return { success: true, stdout, stderr: "", exitCode: 0 };
    }

    if (command === "devbox" && args[0] === "arise") {
      const stdout = "Arising devboxes...\nExisting stopped devboxes have been restarted.\n";
      options?.onStdoutChunk?.(stdout);

      if (this.options.failDevboxArise) {
        return {
          success: false,
          stdout,
          stderr: "devbox arise failed",
          exitCode: 1,
        };
      }

      return { success: true, stdout, stderr: "", exitCode: 0 };
    }

    if (command === "devbox" && args[0] === "status") {
      const stdout = this.options.devboxStatusOutput ?? createDevboxStatusOutput();
      return { success: true, stdout, stderr: "", exitCode: 0 };
    }

    return {
      success: false,
      stdout: "",
      stderr: `Unsupported command: ${command} ${args.join(" ")}`,
      exitCode: 1,
    };
  }

  async fileExists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async directoryExists(path: string): Promise<boolean> {
    return this.directories.has(path) || this.gitRepos.has(path);
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async listDirectory(path: string): Promise<string[]> {
    if (!this.directories.has(path) && !this.gitRepos.has(path)) {
      return [];
    }
    return [];
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    this.files.set(path, content);
    return true;
  }
}
