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
  FileSystemListOptions,
  FileSystemMetadata,
  FileSystemMetadataOptions,
  FileSystemTreeOptions,
  FileWriteStreamOptions,
  FileWriteStreamResult,
  GitCommandOptions,
  GitCommandScope,
  GitEnvironmentVariableName,
} from "./command-executor";
import type { FileSystemTreeEntry } from "@/shared/file-system";
import { createLogger } from "@pablozaiden/webapp/server";
import { MeshCommandExecutorClient } from "./mesh-command-executor-client";
import type { AgentProvider } from "@/shared/settings";
import {
  inferExecutionPathStyle,
  isAbsoluteExecutionPath,
  normalizeExecutionRoot,
} from "./execution-path";
import type { ExecutionPathStyle } from "./execution-path";
import { DomainError } from "../domain/domain-error";
import { streamFileRange } from "./ranged-file-stream";
import {
  EXECUTION_HOST_CAPABILITY_VERSIONS,
  getManagedWorktreesCommandMinimumVersion,
  getUnavailableGitCommandCapability,
  MANAGED_WORKTREES_BASE_VERSION,
  supportsPortableAcpRuntime,
  supportsExecutionHostCapability,
  type ExecutionHostCapabilities,
} from "@/shared/execution-host";

const log = createLogger("core:mesh-command-executor");

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
    const pathStyle = this.configuredPathStyle
      ?? inferExecutionPathStyle(this.configuredDirectory);
    if (!pathStyle) {
      throw new DomainError(
        "execution_host_unavailable",
        "The selected Mesh execution host has no supported path semantics.",
      );
    }
    return pathStyle;
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
    const result = await this.client.exec("printenv", [name]);
    return result.success ? result.stdout.trim() || null : null;
  }

  async getGitEnvironmentVariable(
    name: GitEnvironmentVariableName,
  ): Promise<string | null> {
    this.requireGitRpc("repository");
    return await this.client.getGitEnvironmentVariable(name);
  }

  async execGit(
    directory: string,
    args: string[],
    options: GitCommandOptions,
  ): Promise<CommandResult> {
    this.requireGitRpc(options.scope, args);
    return await this.client.execGit(directory, args, options);
  }

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    return await this.client.exec(command, args, options);
  }

  async isAgentProviderAvailable(provider: AgentProvider): Promise<boolean> {
    if (supportsPortableAcpRuntime(this.capabilities)) {
      return await this.client.isAgentProviderAvailable(provider);
    }
    throw new DomainError(
      "execution_host_capability_unavailable",
      "The selected Mesh execution host does not support acpRuntime.",
      { details: { capability: "acpRuntime" } },
    );
  }

  private requireGitRpc(
    scope: GitCommandScope,
    args: readonly string[] = [],
  ): void {
    const capability = getUnavailableGitCommandCapability(
      this.capabilities,
      scope,
    );
    if (capability) {
      const minimumVersion = capability === "managedWorktrees"
        ? MANAGED_WORKTREES_BASE_VERSION
        : EXECUTION_HOST_CAPABILITY_VERSIONS[capability];
      throw new DomainError(
        "execution_host_capability_unavailable",
        `The selected Mesh execution host does not support ${capability}.`,
        {
          details: {
            capability,
            minimumVersion,
          },
        },
      );
    }
    if (scope !== "managedWorktrees") {
      return;
    }

    const minimumVersion = getManagedWorktreesCommandMinimumVersion(args);
    if (!supportsExecutionHostCapability(
      this.capabilities,
      "managedWorktrees",
      minimumVersion,
    )) {
      throw new DomainError(
        "execution_host_capability_unavailable",
        "The selected Mesh execution host does not support managedWorktrees.",
        {
          details: {
            capability: "managedWorktrees",
            minimumVersion,
            actualVersion: this.capabilities.managedWorktrees ?? 0,
          },
        },
      );
    }
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

  async streamFile(path: string, options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    if (options?.range) {
      if (!supportsExecutionHostCapability(this.capabilities, "commandExecution")) {
        throw new DomainError("execution_host_capability_unavailable", "commandExecution is required for ranged file reads.");
      }
      return streamFileRange(this, path, { ...options, range: options.range });
    }
    return await this.client.streamFile(path, options?.signal);
  }

  async listDirectory(path: string, options?: FileSystemListOptions): Promise<string[]> {
    return await this.client.listDirectory(path, options);
  }

  async getFileMetadata(
    path: string,
    options?: FileSystemMetadataOptions,
  ): Promise<FileSystemMetadata | null> {
    return await this.client.getFileMetadata(path, options);
  }

  async listDirectoryEntries(
    path: string,
    options?: FileSystemListOptions,
  ): Promise<FileSystemDirectoryEntry[]> {
    return await this.client.listDirectoryEntries(path, options);
  }

  async walkDirectoryTree(
    path: string,
    options: FileSystemTreeOptions,
  ): Promise<FileSystemTreeEntry[] | null> {
    if (!supportsExecutionHostCapability(this.capabilities, "directoryTree")) {
      log.debug("Using per-directory traversal: worker has no directoryTree capability");
      return null;
    }
    let entries: FileSystemTreeEntry[];
    try {
      entries = await this.client.walkDirectoryTree(path, options);
    } catch (error) {
      if (
        error instanceof DomainError
        && (
          error.code === "mesh_execution_capability_unavailable"
          || error.code === "mesh_execution_operation_unsupported"
          || error.code === "mesh_execution_result_too_large"
        )
      ) {
        log.warn("Using per-directory traversal after aggregate tree rejection", {
          code: error.code,
        });
        return null;
      }
      throw error;
    }
    const paths = new Set<string>();
    for (const entry of entries) {
      const segments = entry.path.split("/");
      if (
        isAbsoluteExecutionPath(entry.path, this.pathStyle)
        || segments.some((segment) => !segment || segment === "." || segment === "..")
        || paths.has(entry.path)
      ) {
        throw new DomainError(
          "mesh_execution_response_invalid",
          "The Mesh directory tree contains an invalid relative path.",
        );
      }
      paths.add(entry.path);
    }
    return entries;
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
