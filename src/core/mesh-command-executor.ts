/**
 * CommandExecutor implementation backed by a mesh-owned workspace.
 */

import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
  FileDeleteOptions,
  FileMoveOptions,
  FileMoveResult,
  FileStreamOptions,
  FileSystemDirectoryEntry,
  FileSystemMetadata,
  FileWriteStreamOptions,
  FileWriteStreamResult,
  GitCommandOptions,
  GitCommandScope,
  GitEnvironmentVariableName,
} from "./command-executor";
import { MeshCommandExecutorClient } from "./mesh-command-executor-client";
import type { AgentProvider } from "@/shared/settings";
import {
  isAbsoluteExecutionPath,
  normalizeExecutionRoot,
} from "./execution-path";
import type { ExecutionPathStyle } from "./execution-path";
import { DomainError } from "./domain-error";
import {
  EXECUTION_HOST_CAPABILITY_VERSIONS,
  getUnavailableGitCommandCapability,
  supportsGitCommandScope,
  supportsExecutionHostCapability,
  type ExecutionHostCapabilities,
} from "@/shared/execution-host";

export interface MeshCommandExecutorConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  provider: AgentProvider;
  localUserId?: string;
  pathStyle: ExecutionPathStyle | null;
  capabilities: ExecutionHostCapabilities;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class MeshCommandExecutor implements CommandExecutor {
  private readonly configuredPathStyle: ExecutionPathStyle | null;
  private readonly configuredDirectory: string;
  private readonly capabilities: ExecutionHostCapabilities;
  private readonly client: MeshCommandExecutorClient;

  constructor(config: MeshCommandExecutorConfig) {
    this.configuredPathStyle = config.pathStyle;
    this.configuredDirectory = config.directory;
    this.capabilities = config.capabilities;
    this.client = new MeshCommandExecutorClient(config);
  }

  get pathStyle(): ExecutionPathStyle {
    if (!this.configuredPathStyle) {
      throw new DomainError(
        "execution_host_unavailable",
        "The selected Mesh execution host has no supported path semantics.",
      );
    }
    return this.configuredPathStyle;
  }

  async getExecutionDirectory(): Promise<string> {
    const executionDirectory = await this.client.getExecutionDirectory();
    if (executionDirectory) {
      return normalizeExecutionRoot(executionDirectory, this.pathStyle);
    }
    if (isAbsoluteExecutionPath(this.configuredDirectory, this.pathStyle)) {
      return normalizeExecutionRoot(this.configuredDirectory, this.pathStyle);
    }
    throw new DomainError(
      "mesh_execution_response_invalid",
      "The Mesh worker did not return its canonical execution directory for a relative workspace path.",
    );
  }

  async getEnvironmentVariable(name: string): Promise<string | null> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    const result = this.pathStyle === "windows"
      ? await this.client.exec(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write([Environment]::GetEnvironmentVariable($env:CLANKY_ENV_NAME))",
          ],
          { env: { CLANKY_ENV_NAME: name } },
        )
      : await this.client.exec("printenv", [name]);
    return result.success ? result.stdout.trim() || null : null;
  }

  async getGitEnvironmentVariable(
    name: GitEnvironmentVariableName,
  ): Promise<string | null> {
    if (this.supportsGitRpc("repository")) {
      return await this.client.getGitEnvironmentVariable(name);
    }
    this.requireLegacyGitCapability("repository");
    return await this.getEnvironmentVariable(name);
  }

  async execGit(
    directory: string,
    args: string[],
    options: GitCommandOptions,
  ): Promise<CommandResult> {
    if (this.supportsGitRpc(options.scope)) {
      return await this.client.execGit(directory, args, options);
    }
    this.requireLegacyGitCapability(options.scope);
    return await this.exec("git", ["-C", directory, ...args], options);
  }

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    return await this.client.exec(command, args, options);
  }

  private supportsGitRpc(scope: GitCommandScope): boolean {
    return supportsExecutionHostCapability(
      this.capabilities,
      "git",
      EXECUTION_HOST_CAPABILITY_VERSIONS.git,
    ) && (
      scope === "repository"
      || supportsExecutionHostCapability(
        this.capabilities,
        "managedWorktrees",
        EXECUTION_HOST_CAPABILITY_VERSIONS.managedWorktrees,
      )
    );
  }

  private requireLegacyGitCapability(scope: GitCommandScope): void {
    if (supportsGitCommandScope(this.capabilities, scope)) {
      return;
    }
    const capability = getUnavailableGitCommandCapability(
      this.capabilities,
      scope,
    ) ?? "git";
    throw new DomainError(
      "execution_host_capability_unavailable",
      `The selected Mesh execution host does not support ${capability}.`,
      {
        details: {
          capability,
          minimumVersion: EXECUTION_HOST_CAPABILITY_VERSIONS[capability],
        },
      },
    );
  }

  async fileExists(path: string): Promise<boolean> {
    return await this.client.fileExists(path);
  }

  async directoryExists(path: string): Promise<boolean> {
    return await this.client.directoryExists(path);
  }

  async readFile(path: string, options?: FileStreamOptions): Promise<string | null> {
    return await this.client.readFile(path, options?.signal);
  }

  async streamFile(_path: string, _options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    return await this.client.streamFile(_path, _options?.signal);
  }

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    return await this.client.listDirectory(path, options);
  }

  async getFileMetadata(
    path: string,
    options?: { includeContentHash?: boolean },
  ): Promise<FileSystemMetadata | null> {
    return await this.client.getFileMetadata(path, options);
  }

  async listDirectoryEntries(
    path: string,
    options?: { includeHidden?: boolean },
  ): Promise<FileSystemDirectoryEntry[]> {
    return await this.client.listDirectoryEntries(path, options);
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    return await this.client.writeFile(path, content);
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    return await this.client.writeFileStream(path, stream, options);
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
    return await this.client.copyFile(sourcePath, destinationPath);
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
    options?: FileMoveOptions,
  ): Promise<FileMoveResult> {
    return await this.client.movePath(sourcePath, destinationPath, options);
  }

  async deletePath(path: string, options: FileDeleteOptions): Promise<boolean> {
    return await this.client.deletePath(path, options);
  }

  close(): void {
    void this.client.releaseSession();
  }
}

export { MeshCommandExecutorClient } from "./mesh-command-executor-client";
