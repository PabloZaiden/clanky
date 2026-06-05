/**
 * Workspace file explorer service.
 */

import { backendManager } from "./backend-manager";
import { fileExplorerService, resolveFileExplorerRootDirectory } from "./file-explorer-service";
import type {
  Workspace,
  WorkspaceFileEntry,
  WorkspaceFileMetadataResponse,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileTreeResponse,
  WorkspaceFileWriteResponse,
} from "../types";

export interface WorkspaceFileImageReadResponse {
  workspaceId: string;
  file: WorkspaceFileEntry;
  contentType: string;
  data: Uint8Array;
}

export interface WorkspaceFileDownloadReadResponse {
  workspaceId: string;
  file: WorkspaceFileEntry;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

export interface WorkspaceFileDownloadMetadataResponse {
  workspaceId: string;
  file: WorkspaceFileEntry;
  contentType: string;
}

class WorkspaceFileService {
  private async getTarget(workspace: Workspace, startDirectory?: string) {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const rootDirectory = await resolveFileExplorerRootDirectory(
      executor,
      workspace.directory,
      startDirectory,
    );
    return {
      id: workspace.id,
      rootDirectory,
      pathScopeLabel: "active workspace explorer root",
      executor,
    };
  }

  async listDirectory(
    workspace: Workspace,
    requestedPath = "",
    options?: { includeHidden?: boolean; startDirectory?: string },
  ): Promise<WorkspaceFileListResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.listDirectory(target, requestedPath, options);

    return {
      workspaceId: workspace.id,
      directory: response.directory,
      entries: response.entries,
    };
  }

  async readFile(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string },
  ): Promise<WorkspaceFileReadResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.readFile(target, requestedPath);

    return {
      workspaceId: workspace.id,
      file: response.file,
      content: response.content,
    };
  }

  async readImageFile(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string },
  ): Promise<WorkspaceFileImageReadResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.readImageFile(target, requestedPath);

    return {
      workspaceId: workspace.id,
      file: response.file,
      contentType: response.contentType,
      data: response.data,
    };
  }

  async readDownloadFile(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string; signal?: AbortSignal },
  ): Promise<WorkspaceFileDownloadReadResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.readDownloadFile(target, requestedPath, {
      signal: options?.signal,
    });

    return {
      workspaceId: workspace.id,
      file: response.file,
      contentType: response.contentType,
      stream: response.stream,
    };
  }

  async getDownloadMetadata(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string },
  ): Promise<WorkspaceFileDownloadMetadataResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.getDownloadMetadata(target, requestedPath);

    return {
      workspaceId: workspace.id,
      file: response.file,
      contentType: response.contentType,
    };
  }

  async loadTree(
    workspace: Workspace,
    options?: { startDirectory?: string },
  ): Promise<WorkspaceFileTreeResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.loadTree(target);

    return {
      workspaceId: workspace.id,
      entriesByDirectory: response.entriesByDirectory,
    };
  }

  async getMetadata(
    workspace: Workspace,
    requestedPath: string,
    options?: { startDirectory?: string },
  ): Promise<WorkspaceFileMetadataResponse["file"] | null> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    return await fileExplorerService.getMetadata(target, requestedPath);
  }

  async writeFile(
    workspace: Workspace,
    requestedPath: string,
    content: string,
    options?: {
      expectedVersionToken?: string | null;
      overwrite?: boolean;
      startDirectory?: string;
    },
  ): Promise<WorkspaceFileWriteResponse> {
    const target = await this.getTarget(workspace, options?.startDirectory);
    const response = await fileExplorerService.writeFile(target, requestedPath, content, options);

    return {
      success: response.success,
      workspaceId: workspace.id,
      file: response.file,
      overwritten: response.overwritten,
    };
  }
}

export const workspaceFileService = new WorkspaceFileService();
