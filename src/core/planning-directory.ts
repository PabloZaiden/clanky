import {
  resolveCommandExecutorDirectory,
  type CommandExecutor,
} from "./command-executor";
import { joinExecutionPath } from "./execution-path";
import { ManagedPathService } from "./managed-path-service";

export async function ensurePlanningDirectory(
  executor: CommandExecutor,
  directory: string,
): Promise<string> {
  const executionDirectory = await resolveCommandExecutorDirectory(
    executor,
    directory,
  );
  const planningDir = new ManagedPathService(
    executor.pathStyle,
  ).getPlanningDirectoryPath(executionDirectory);
  const exists = await executor.directoryExists(planningDir);
  if (exists) {
    return planningDir;
  }

  const placeholderPath = joinExecutionPath(
    executor.pathStyle,
    planningDir,
    `.clanky-directory-init-${crypto.randomUUID()}`,
  );
  if (!(await executor.writeFile(placeholderPath, ""))) {
    throw new Error(`Failed to create ${planningDir}`);
  }
  if (!(await executor.deletePath(placeholderPath, { kind: "file" }))) {
    throw new Error(`Failed to remove temporary planning file ${placeholderPath}`);
  }

  return planningDir;
}

export async function clearPlanningDirectory(
  executor: CommandExecutor,
  planningDirectory: string,
  preservedNames: ReadonlySet<string> = new Set(),
): Promise<{ deletedNames: string[]; preservedNames: string[] }> {
  const entries = await executor.listDirectoryEntries(planningDirectory, {
    includeHidden: true,
  });
  const deletedNames: string[] = [];
  const observedPreservedNames: string[] = [];

  for (const entry of entries) {
    if (preservedNames.has(entry.name)) {
      observedPreservedNames.push(entry.name);
      continue;
    }
    const path = joinExecutionPath(
      executor.pathStyle,
      planningDirectory,
      entry.name,
    );
    const deleted = await executor.deletePath(path, {
      kind: entry.kind,
      ...(entry.kind === "directory" ? { recursive: true } : {}),
    });
    if (!deleted) {
      throw new Error(`Failed to delete ${path}`);
    }
    deletedNames.push(entry.name);
  }

  return {
    deletedNames,
    preservedNames: observedPreservedNames,
  };
}
