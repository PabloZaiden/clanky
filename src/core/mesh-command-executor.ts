/**
 * CommandExecutor implementation backed by a mesh-owned workspace.
 */

import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
  FileStreamOptions,
} from "./command-executor";
import { DomainError } from "./domain-error";
import { MeshCommandExecutorClient } from "./mesh-command-executor-client";

export interface MeshCommandExecutorConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  localUserId?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class MeshCommandExecutor implements CommandExecutor {
  private readonly client: MeshCommandExecutorClient;

  constructor(config: MeshCommandExecutorConfig) {
    this.client = new MeshCommandExecutorClient(config);
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
    throw new DomainError(
      "mesh_execution_stream_unsupported",
      "Streaming files is not supported by the mesh CommandExecutor protocol.",
    );
  }

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    return await this.client.listDirectory(path, options);
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    return await this.client.writeFile(path, content);
  }

  close(): void {
    this.client.closeSession();
  }
}

export { MeshCommandExecutorClient } from "./mesh-command-executor-client";
