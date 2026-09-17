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
} from "./command-executor";
import { MeshCommandExecutorClient } from "./mesh-command-executor-client";
import type { AgentProvider } from "@/shared/settings";
import type { ExecutionPathStyle } from "./execution-path";
import { DomainError } from "./domain-error";

export interface MeshCommandExecutorConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  provider: AgentProvider;
  localUserId?: string;
  pathStyle: ExecutionPathStyle | null;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class MeshCommandExecutor implements CommandExecutor {
  private readonly configuredPathStyle: ExecutionPathStyle | null;
  private readonly client: MeshCommandExecutorClient;

  constructor(config: MeshCommandExecutorConfig) {
    this.configuredPathStyle = config.pathStyle;
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

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    return await this.client.exec(command, args, options);
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
