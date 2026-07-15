import type { TaskCtx } from "./context";
import type { Task } from "@/shared/task";
import { GitService } from "../git";
import { getActiveTaskByDirectory } from "../../persistence/tasks";
import { TaskOperationError } from "./task-errors";

export async function validateMainCheckoutStartImpl(_ctx: TaskCtx, task: Task, git: GitService): Promise<void> {
  if (task.config.useWorktree) {
    return;
  }

  const activeTask = await getActiveTaskByDirectory(task.config.directory, task.config.workspaceId);
  if (activeTask && activeTask.config.id !== task.config.id) {
    throw new TaskOperationError(
      "directory_in_use",
      `Cannot start without a worktree while task "${activeTask.config.name}" is already active in this workspace.`,
      {
        details: {
          taskId: task.config.id,
          activeTaskId: activeTask.config.id,
        },
      },
    );
  }

  const hasChanges = await git.hasUncommittedChanges(task.config.directory);
  if (!hasChanges) {
    return;
  }

  const changedFiles = await git.getChangedFiles(task.config.directory);
  throw new TaskOperationError(
    "uncommitted_changes",
    "Cannot start without a worktree because the repository has uncommitted changes.",
    { details: { taskId: task.config.id, changedFiles } },
  );
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
