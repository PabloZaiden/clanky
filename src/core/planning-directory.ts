import type { CommandExecutor } from "./command-executor";
import { getPlanningDirectoryPath } from "../lib/planning-files";

export async function ensurePlanningDirectory(
  executor: CommandExecutor,
  directory: string,
): Promise<string> {
  const planningDir = getPlanningDirectoryPath(directory);
  const exists = await executor.directoryExists(planningDir);
  if (exists) {
    return planningDir;
  }

  const result = await executor.exec("mkdir", ["-p", planningDir], {
    cwd: directory,
  });
  if (!result.success) {
    throw new Error(`Failed to create ${planningDir}: ${result.stderr || result.stdout || "unknown error"}`);
  }

  return planningDir;
}
