import {
  resolveCommandExecutorDirectory,
  type CommandExecutor,
} from "./command-executor";
import { ensurePlanningDirectory } from "./planning-directory";
import { ManagedPathService } from "./managed-path-service";
import { InvalidCurrentPlanError } from "@/shared/chat";

const PLAN_READY_MARKER = /<promise>PLAN_READY<\/promise>/gi;

export interface ValidatedPlanningFiles {
  planContent: string;
  statusContent?: string;
}

export function normalizePlanContent(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(PLAN_READY_MARKER, "").trim();
}

export function normalizeUploadedPlanningFiles(files: ValidatedPlanningFiles): ValidatedPlanningFiles {
  const planContent = normalizePlanContent(files.planContent);
  if (!planContent) {
    throw new InvalidCurrentPlanError("The uploaded plan file is empty.");
  }

  const statusContent = files.statusContent?.trim();
  return {
    planContent,
    statusContent: statusContent ? statusContent : undefined,
  };
}

export async function writePlanningFiles(
  executor: CommandExecutor,
  directory: string,
  files: ValidatedPlanningFiles,
): Promise<void> {
  await ensurePlanningDirectory(executor, directory);
  const managedPaths = new ManagedPathService(executor.pathStyle);
  const executionDirectory = await resolveCommandExecutorDirectory(
    executor,
    directory,
  );

  const planWritten = await writePlanningFile(
    executor,
    managedPaths.getPlanFilePath(executionDirectory),
    files.planContent,
  );
  if (!planWritten) {
    throw new Error("Failed to write plan.md for the seeded task");
  }

  const nextStatusContent = files.statusContent?.trim();
  if (!nextStatusContent) {
    return;
  }

  const statusWritten = await writePlanningFile(
    executor,
    managedPaths.getStatusFilePath(executionDirectory),
    nextStatusContent,
  );
  if (!statusWritten) {
    throw new Error("Failed to write status.md for the seeded task");
  }
}

async function writePlanningFile(
  executor: CommandExecutor,
  destinationPath: string,
  content: string,
): Promise<boolean> {
  if (executor.writeFileStream) {
    const result = await executor.writeFileStream(destinationPath, new Blob([content]).stream());
    return result.success;
  }

  return await executor.writeFile(destinationPath, content);
}
