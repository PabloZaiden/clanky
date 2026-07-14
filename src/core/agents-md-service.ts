/**
 * Core operations for reading and optimizing workspace AGENTS.md files.
 *
 * Workspace files are always accessed through the workspace host's
 * CommandExecutor. This keeps remote workspaces independent from the Clanky
 * server filesystem and leaves HTTP response mapping to the API layer.
 */

import { join } from "path";
import type { OptimizationAnalysis, OptimizationPreview } from "./agents-md-optimizer";
import {
  analyzeAgentsMd,
  optimizeContent,
  previewOptimization,
} from "./agents-md-optimizer";
import { backendManager } from "./backend-manager";
import type { CommandExecutor } from "./command-executor";
import { DomainError } from "./domain-error";
import { workspaceManager } from "./workspace-manager";

export interface AgentsMdReadResult {
  content: string;
  fileExists: boolean;
  analysis: OptimizationAnalysis;
}

export interface AgentsMdOptimizeResult {
  alreadyOptimized: boolean;
  content: string;
  analysis: OptimizationAnalysis;
}

class AgentsMdService {
  private getPath(directory: string): string {
    return join(directory, "AGENTS.md");
  }

  private async readCurrent(
    workspaceId: string,
  ): Promise<{
    content: string | null;
    fileExists: boolean;
    executor: CommandExecutor;
    path: string;
  }> {
    const workspace = await workspaceManager.requireWorkspace(workspaceId);
    const executor = await backendManager.getCommandExecutorAsync(
      workspace.id,
      workspace.directory,
    );
    const path = this.getPath(workspace.directory);
    const fileExists = await executor.fileExists(path);
    const content = fileExists ? await executor.readFile(path) : null;

    if (fileExists && content === null) {
      throw new DomainError(
        "agents_md_read_failed",
        "AGENTS.md exists but could not be read (possible permissions or transient error)",
        { details: { workspaceId } },
      );
    }

    return { content, fileExists, executor, path };
  }

  async read(workspaceId: string): Promise<AgentsMdReadResult> {
    const current = await this.readCurrent(workspaceId);
    return {
      content: current.content ?? "",
      fileExists: current.fileExists,
      analysis: analyzeAgentsMd(current.content),
    };
  }

  async preview(workspaceId: string): Promise<OptimizationPreview> {
    const current = await this.readCurrent(workspaceId);
    return previewOptimization(current.content, current.fileExists);
  }

  async optimize(workspaceId: string): Promise<AgentsMdOptimizeResult> {
    const current = await this.readCurrent(workspaceId);
    const analysis = analyzeAgentsMd(current.content);

    if (analysis.isOptimized && !analysis.updateAvailable) {
      return {
        alreadyOptimized: true,
        content: current.content ?? "",
        analysis,
      };
    }

    const optimizedContent = optimizeContent(current.content, analysis);
    const writeSuccess = await current.executor.writeFile(current.path, optimizedContent);

    if (!writeSuccess) {
      throw new DomainError(
        "agents_md_write_failed",
        "Failed to write AGENTS.md to the workspace",
        { details: { workspaceId } },
      );
    }

    return {
      alreadyOptimized: false,
      content: optimizedContent,
      analysis: analyzeAgentsMd(optimizedContent),
    };
  }
}

export const agentsMdService = new AgentsMdService();
