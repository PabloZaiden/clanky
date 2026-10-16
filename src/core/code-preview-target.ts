/**
 * Resolves an existing VS Code working directory without preparing agent work.
 */

import type { CodePreviewOptions, Workspace } from "@/shared";
import { DomainError } from "../domain/domain-error";
import { backendManager } from "./backend-manager";
import { chatManager } from "./chat-manager";
import { taskManager } from "./task-manager";
import { getTaskWorkingDirectory } from "./task/task-types";
import { GitService } from "./git";
import { executionHostService } from "./execution-host-service";

function selectEntity<T extends { config: { id: string; name: string } }>(
  entities: T[],
  reference: string,
): T {
  const byId = entities.find((entity) => entity.config.id === reference);
  if (byId) return byId;
  const matches = entities.filter((entity) => entity.config.name === reference);
  if (matches.length === 1) return matches[0]!;
  throw new DomainError(
    matches.length > 1 ? "code_target_ambiguous" : "code_target_not_found",
    matches.length > 1
      ? `Name is ambiguous; use an ID: ${matches.map((entity) => entity.config.id).join(", ")}`
      : "Chat or task not found in this workspace.",
  );
}

export async function resolveCodePreviewTarget(workspace: Workspace, options: CodePreviewOptions) {
  executionHostService.requireBindingCapability(workspace.executionHostBinding, "commandExecution");
  const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
  let directory = workspace.directory;
  if (options.task) {
    const tasks = (await taskManager.getAllTasks()).filter((task) => task.config.workspaceId === workspace.id);
    const task = selectEntity(tasks, options.task);
    const taskDirectory = getTaskWorkingDirectory(task);
    if (!taskDirectory) {
      throw new DomainError("code_directory_unavailable", "The task worktree has not been prepared. Nothing was created.");
    }
    directory = task.config.useWorktree
      ? await GitService.withExecutor(executor).assertCanonicalManagedWorktreePath(
          task.config.directory, task.config.id, taskDirectory,
        )
      : taskDirectory;
  } else if (options.chat) {
    const chat = selectEntity(await chatManager.getChatsByWorkspace(workspace.id, { includeTaskChats: true }), options.chat);
    directory = await chatManager.getWorkingDirectory(chat);
  }
  if (!(await executor.directoryExists(directory))) {
    throw new DomainError("code_directory_unavailable", "The selected working directory no longer exists. Nothing was created.");
  }
  return { executor, directory };
}
