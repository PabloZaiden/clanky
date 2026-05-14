/**
 * Git operation helpers for LoopEngine.
 */

import type { LoopConfig, LoopState, GitCommit } from "../../types/loop";
import type { LogLevel, LoopEvent } from "../../types/events";
import { createTimestamp } from "../../types/events";
import type { PromptInput } from "../../backends/types";
import type { GitService } from "../git-service";
import type { LoopBackend } from "./engine-types";
import { buildLoopBranchName } from "../branch-name";
import { backendManager } from "../backend-manager";
import { formatConventionalCommit, normalizeAiCommitMessage } from "../conventional-commits";
import { syncMainCheckoutBeforeWorktree } from "../git/worktree-sync";
import { log } from "../logger";
import { getPlanningDirectoryPath } from "../../lib/planning-files";

export interface GitOperationContext {
  git: GitService;
  config: LoopConfig;
  state: LoopState;
  workingDirectory: string;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<LoopState>) => void;
  emit: (event: LoopEvent) => void;
}

export interface GitCommitContext extends GitOperationContext {
  backend: LoopBackend;
  sessionId: string | null;
}

export async function clearLoopPlanningFolder(ctx: GitOperationContext): Promise<void> {
  const planningDir = getPlanningDirectoryPath(ctx.workingDirectory);

  try {
    const executor = await backendManager.getCommandExecutorAsync(ctx.config.workspaceId, ctx.workingDirectory);

    const exists = await executor.directoryExists(planningDir);

    if (!exists) {
      ctx.emitLog("debug", ".ralph-planning directory does not exist, skipping clear");
      return;
    }

    const files = await executor.listDirectory(planningDir);

    if (files.length === 0) {
      ctx.emitLog("debug", ".ralph-planning directory is already empty");
      return;
    }

    const filesToDelete = files.filter((file) => file !== ".gitkeep");

    if (filesToDelete.length === 0) {
      ctx.emitLog("debug", ".ralph-planning directory only contains .gitkeep");
      return;
    }

    const fileArgs = filesToDelete.map((file) => `${planningDir}/${file}`);
    const result = await executor.exec("rm", ["-rf", ...fileArgs], {
      cwd: ctx.workingDirectory,
    });

    if (!result.success) {
      throw new Error(`rm command failed: ${result.stderr}`);
    }

    ctx.emitLog("info", `Cleared .ralph-planning folder: ${filesToDelete.length} file(s) deleted`, {
      deletedCount: filesToDelete.length,
      preservedFiles: files.includes(".gitkeep") ? [".gitkeep"] : [],
    });

    const hasChanges = await ctx.git.hasUncommittedChanges(ctx.workingDirectory);
    if (hasChanges) {
      ctx.emitLog("info", "Committing cleared .ralph-planning folder...");
      try {
        const commitInfo = await ctx.git.commit(
          ctx.workingDirectory,
          formatConventionalCommit("chore", ctx.config.git.commitScope, "clear .ralph-planning folder for fresh start"),
          { expectedBranch: ctx.state.git?.workingBranch }
        );
        ctx.emitLog("info", `Committed .ralph-planning folder cleanup`, {
          sha: commitInfo.sha.slice(0, 8),
          filesChanged: commitInfo.filesChanged,
        });
      } catch (commitError) {
        ctx.emitLog("warn", `Failed to commit .ralph-planning folder cleanup: ${String(commitError)}`);
      }
    }
  } catch (error) {
    ctx.emitLog("warn", `Failed to clear .ralph-planning folder: ${String(error)}`);
  }
}

export async function setupLoopGitBranch(ctx: GitOperationContext, _allowPlanningFolderChanges = false): Promise<void> {
  const directory = ctx.config.directory;

  ctx.emitLog("debug", "Checking if directory is a git repository", { directory });
  const isRepo = await ctx.git.isGitRepo(directory);
  if (!isRepo) {
    throw new Error(`Directory is not a git repository: ${directory}`);
  }

  const originalBranch = await resolveOriginalBranch(ctx, directory);
  const branchName = ctx.config.useWorktree
    ? await resolveBranchName(ctx, directory)
    : await resolveDirectBranchName(ctx, directory);

  if (originalBranch === branchName && !ctx.state.git?.originalBranch) {
    ctx.emitLog("warn", `Base branch matches generated working branch (${originalBranch}); preserving base branch but continuing`, {
      originalBranch,
      branchName,
    });
  }

  let worktreePath: string | undefined;
  if (ctx.config.useWorktree) {
    await ctx.git.ensureWorktreeExcluded(directory);
    await syncMainCheckoutBeforeWorktree({
      git: ctx.git,
      directory,
      baseBranch: originalBranch,
      onInfo: (message: string) => {
        ctx.emitLog("info", message);
      },
      onDebug: (message: string) => {
        ctx.emitLog("debug", message);
      },
    });
    worktreePath = await setupWorktree(ctx, directory, branchName, originalBranch);
  }

  ctx.updateState({
    git: {
      originalBranch,
      workingBranch: branchName,
      worktreePath,
      commits: ctx.state.git?.commits ?? [],
    },
  });

  log.debug("[LoopEngine] About to emit 'Git branch setup complete' log");
  ctx.emitLog("info", `Git branch setup complete`, {
    originalBranch,
    workingBranch: branchName,
    worktreePath: worktreePath ?? directory,
    useWorktree: ctx.config.useWorktree,
  });
  log.debug("[LoopEngine] Exiting setupGitBranch");
}

async function resolveBranchName(ctx: GitOperationContext, directory: string): Promise<string> {
  if (ctx.state.git?.workingBranch) {
    return ctx.state.git.workingBranch;
  }

  const baseBranchName = buildLoopBranchName(ctx.config.name, ctx.config.prompt);

  let branchName = baseBranchName;
  let collisionIndex = 2;

  while (await ctx.git.branchExists(directory, branchName)) {
    branchName = `${baseBranchName}-${collisionIndex}`;
    collisionIndex += 1;
  }

  if (branchName !== baseBranchName) {
    ctx.emitLog("info", `Generated unique working branch after collision: ${branchName}`, {
      baseBranchName,
      branchName,
    });
  }

  return branchName;
}

async function resolveDirectBranchName(ctx: GitOperationContext, directory: string): Promise<string> {
  if (ctx.state.git?.workingBranch) {
    return ctx.state.git.workingBranch;
  }

  const branch = await ctx.git.getCurrentBranch(directory);
  ctx.emitLog("info", `Using current branch directly: ${branch}`);
  return branch;
}

async function resolveOriginalBranch(ctx: GitOperationContext, directory: string): Promise<string> {
  if (ctx.state.git?.originalBranch) {
    const branch = ctx.state.git.originalBranch;
    ctx.emitLog("info", `Preserving existing original branch: ${branch}`);
    return branch;
  }
  if (!ctx.config.useWorktree) {
    const branch = await ctx.git.getCurrentBranch(directory);
    ctx.emitLog("info", `Using current branch directly as original branch: ${branch}`);
    return branch;
  }
  if (ctx.config.baseBranch) {
    const branch = ctx.config.baseBranch;
    ctx.emitLog("info", `Using configured base branch: ${branch}`);
    return branch;
  }
  const branch = await ctx.git.getCurrentBranch(directory);
  ctx.emitLog("info", `Current branch: ${branch}`);
  return branch;
}

async function setupWorktree(ctx: GitOperationContext, directory: string, branchName: string, originalBranch: string): Promise<string> {
  const worktreePath = `${directory}/.ralph-worktrees/${ctx.config.id}`;

  const branchExists = await ctx.git.branchExists(directory, branchName);

  const wtExists = await ctx.git.worktreeExists(directory, worktreePath);

  if (wtExists) {
    ctx.emitLog("info", `Reusing existing worktree at: ${worktreePath}`);
  } else if (branchExists) {
    ctx.emitLog("info", `Recreating worktree for existing branch: ${branchName}`);
    await ctx.git.addWorktreeForExistingBranch(directory, worktreePath, branchName);
  } else {
    ctx.emitLog("info", `Creating new worktree with branch: ${branchName} at ${worktreePath}`);
    await ctx.git.createWorktree(directory, worktreePath, branchName, originalBranch);
  }

  return worktreePath;
}

export async function commitLoopIteration(ctx: GitCommitContext, iteration: number, responseContent: string): Promise<void> {
  const directory = ctx.workingDirectory;
  const hasChanges = await ctx.git.hasUncommittedChanges(directory);

  if (!hasChanges) {
    ctx.emitLog("info", "No changes to commit");
    return;
  }

  let message: string;
  try {
    ctx.emitLog("info", "Generating commit message...");
    message = await generateCommitMessage(ctx, iteration, responseContent);
  } catch (err) {
    ctx.emitLog("warn", `Failed to generate commit message: ${String(err)}, using fallback`);
    message = formatConventionalCommit("chore", ctx.config.git.commitScope, `iteration ${iteration}`);
  }

  try {
    ctx.emitLog("info", "Committing changes...");
    const commitInfo = await ctx.git.commit(directory, message, {
      expectedBranch: ctx.state.git?.workingBranch,
    });

    const commit: GitCommit = {
      iteration,
      sha: commitInfo.sha,
      message,
      timestamp: createTimestamp(),
      filesChanged: commitInfo.filesChanged,
    };

    if (ctx.state.git) {
      ctx.updateState({
        git: {
          ...ctx.state.git,
          commits: [...ctx.state.git.commits, commit],
        },
      });
    }

    ctx.emitLog("info", `Committed ${commitInfo.filesChanged} file(s)`, {
      sha: commitInfo.sha.slice(0, 8),
      message: message.split("\n")[0],
    });

    ctx.emit({
      type: "loop.git.commit",
      loopId: ctx.config.id,
      iteration,
      commit,
      timestamp: createTimestamp(),
    });
  } catch (err) {
    ctx.emitLog("warn", `Failed to commit: ${String(err)}`);
    log.error(`Failed to commit iteration ${iteration}: ${String(err)}`);
  }
}

async function generateCommitMessage(ctx: GitCommitContext, iteration: number, responseContent: string): Promise<string> {
  const scope = ctx.config.git.commitScope;

  if (!ctx.sessionId) {
    return formatConventionalCommit("chore", scope, `iteration ${iteration}`);
  }

  const changedFiles = await ctx.git.getChangedFiles(ctx.workingDirectory);
  if (changedFiles.length === 0) {
    return formatConventionalCommit("chore", scope, `iteration ${iteration}`);
  }

  const prompt: PromptInput = {
    parts: [{
      type: "text",
      text: `Generate a concise git commit message following the Conventional Commits format for the following changes. Do not include any explanation, just output the commit message directly.

Changed files:
${changedFiles.map(f => `- ${f}`).join("\n")}

Summary of work done this iteration:
${responseContent.slice(0, 500)}...

The commit message MUST follow one of these Conventional Commits formats:
  type: description
  type(scope): description

Valid types: feat, fix, refactor, docs, style, test, build, ci, chore, perf, revert
- feat: a new feature
- fix: a bug fix
- refactor: code restructuring without behavior change
- docs: documentation changes
- chore: maintenance tasks

Rules:
1. Only include a scope when it names a specific module, section, topic, or area touched by the change
2. Never use generic scopes like "ralph"
3. If no meaningful scope stands out, omit the scope entirely and use "type: description"
4. First line max 72 characters
5. Be specific about what changed
6. Optionally include a blank line followed by more details

Output ONLY the commit message, nothing else.`
    }],
  };

  try {
    const response = await ctx.backend.sendPrompt(ctx.sessionId, prompt);
    const generatedMessage = response.content.trim();

    if (generatedMessage && generatedMessage.length > 0 && generatedMessage.length < 500) {
      return normalizeAiCommitMessage(generatedMessage, scope);
    }
  } catch (err) {
    log.warn(`Failed to generate commit message via AI: ${String(err)}`);
  }

  const fileList = changedFiles.slice(0, 3).join(", ");
  const moreFiles = changedFiles.length > 3 ? ` (+${changedFiles.length - 3} more)` : "";
  return formatConventionalCommit("chore", scope, `iteration ${iteration} - ${fileList}${moreFiles}`);
}
