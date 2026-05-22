import type { TaskCtx } from "./context";
import type { Task } from "../../types/task";
import { GitService } from "../git-service";
import { getActiveTaskByDirectory } from "../../persistence/tasks";

export async function validateMainCheckoutStartImpl(_ctx: TaskCtx, task: Task, git: GitService): Promise<void> {
  if (task.config.useWorktree) {
    return;
  }

  const activeTask = await getActiveTaskByDirectory(task.config.directory, task.config.workspaceId);
  if (activeTask && activeTask.config.id !== task.config.id) {
    const error = new Error(
      `Cannot start without a worktree while task "${activeTask.config.name}" is already active in this workspace.`,
    ) as Error & { code: string; status: number };
    error.code = "directory_in_use";
    error.status = 409;
    throw error;
  }

  const hasChanges = await git.hasUncommittedChanges(task.config.directory);
  if (!hasChanges) {
    return;
  }

  const changedFiles = await git.getChangedFiles(task.config.directory);
  const error = new Error(
    "Cannot start without a worktree because the repository has uncommitted changes.",
  ) as Error & { code: string; status: number; changedFiles: string[] };
  error.code = "uncommitted_changes";
  error.status = 409;
  error.changedFiles = changedFiles;
  throw error;
}

export async function ensureTaskBranchCheckedOutImpl(
  _ctx: TaskCtx,
  task: Task,
  git: GitService,
  workingDirectory: string
): Promise<void> {
  if (task.config.useWorktree) {
    return;
  }

  const workingBranch = task.state.git?.workingBranch;
  if (!workingBranch) {
    return;
  }

  const currentBranch = await git.getCurrentBranch(workingDirectory);
  if (currentBranch !== workingBranch) {
    await git.checkoutBranch(workingDirectory, workingBranch);
  }
}
