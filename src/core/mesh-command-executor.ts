/**
 * CommandExecutor implementation backed by a mesh-owned workspace.
 */

import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
  FileStreamOptions,
  FileWriteStreamOptions,
  FileWriteStreamResult,
} from "./command-executor";
import { MeshCommandExecutorClient } from "./mesh-command-executor-client";
import type { AgentProvider } from "@/shared/settings";

export interface MeshCommandExecutorConfig {
  workspaceId: string;
  directory: string;
  executionNodeId: string;
  provider: AgentProvider;
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
    return await this.client.streamFile(_path, _options?.signal);
  }

  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    return await this.client.listDirectory(path, options);
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

  close(): void {
    this.client.closeSession();
  }
}

export { MeshCommandExecutorClient } from "./mesh-command-executor-client";
