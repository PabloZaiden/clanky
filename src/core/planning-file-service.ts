import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { CommandExecutor } from "./command-executor";
import { ensurePlanningDirectory } from "./planning-directory";
import {
  DEFAULT_PLAN_DISPLAY_PATH,
  getPlanFilePath,
  getStatusFilePath,
  normalizePlanningBasePath,
  STATUS_FILE_NAME,
} from "../lib/planning-files";
import { InvalidCurrentPlanError } from "../types/chat";

const PLAN_READY_MARKER = /<promise>PLAN_READY<\/promise>/gi;

export interface ValidatedPlanningFiles {
  planContent: string;
  statusContent?: string;
  planSourcePath?: string;
  statusSourcePath?: string;
}

export function normalizePlanContent(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(PLAN_READY_MARKER, "").trim();
}

function hasMeaningfulPlanContent(content: string): boolean {
  return normalizePlanContent(content).length > 0;
}

function sanitizeTaskNameForStatusContent(taskName: string): string {
  return taskName
    .replace(/[`]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface PlanningFileSource {
  planPath: string;
  statusPath: string;
  displayPath: string;
  isDefault: boolean;
}

function sanitizePlanPathForMessage(planPath: string): string {
  return planPath
    .replace(/[`]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function isExplicitAbsolutePlanPath(rawPath: string, normalizedPath: string): boolean {
  return pathPosix.isAbsolute(normalizedPath)
    || pathWin32.isAbsolute(rawPath)
    || pathWin32.isAbsolute(normalizedPath);
}

function isPathContainedWithinWorkspace(workspaceDirectory: string, targetPath: string): boolean {
  const relativePath = pathPosix.relative(workspaceDirectory, targetPath);
  return relativePath === ""
    || (!relativePath.startsWith("../") && relativePath !== ".." && !pathPosix.isAbsolute(relativePath));
}

function resolvePlanningFileSource(directory: string, requestedPlanPath?: string): PlanningFileSource {
  const trimmedPlanPath = requestedPlanPath?.trim() ?? "";
  if (!trimmedPlanPath) {
    return {
      planPath: getPlanFilePath(directory),
      statusPath: getStatusFilePath(directory),
      displayPath: DEFAULT_PLAN_DISPLAY_PATH,
      isDefault: true,
    };
  }

  const workspaceDirectory = normalizePlanningBasePath(directory);
  const normalizedRequestedPath = pathPosix.normalize(trimmedPlanPath.replaceAll("\\", "/"));
  if (!normalizedRequestedPath || normalizedRequestedPath === "." || normalizedRequestedPath === "/") {
    throw new InvalidCurrentPlanError("The selected plan file path must point to a plan file.");
  }
  const isAbsolutePlanPath = isExplicitAbsolutePlanPath(trimmedPlanPath, normalizedRequestedPath);
  const planPath = isAbsolutePlanPath
    ? normalizedRequestedPath
    : pathPosix.normalize(pathPosix.join(workspaceDirectory, normalizedRequestedPath));
  if (!isAbsolutePlanPath && !isPathContainedWithinWorkspace(workspaceDirectory, planPath)) {
    throw new InvalidCurrentPlanError("Relative plan file paths must stay within the current chat workspace.");
  }

  return {
    planPath,
    statusPath: pathPosix.join(pathPosix.dirname(planPath), STATUS_FILE_NAME),
    displayPath: sanitizePlanPathForMessage(normalizedRequestedPath),
    isDefault: false,
  };
}

export async function readValidatedPlanningFiles(
  executor: CommandExecutor,
  directory: string,
  requestedPlanPath?: string,
): Promise<ValidatedPlanningFiles> {
  const source = resolvePlanningFileSource(directory, requestedPlanPath);
  const rawPlanContent = await executor.readFile(source.planPath);
  if (rawPlanContent === null) {
    if (source.isDefault) {
      throw new InvalidCurrentPlanError("No Clanky plan file was found in the current chat workspace.");
    }
    throw new InvalidCurrentPlanError(`No plan file was found at "${source.displayPath}".`);
  }
  const planContent = normalizePlanContent(rawPlanContent);
  if (!hasMeaningfulPlanContent(rawPlanContent)) {
    if (source.isDefault) {
      throw new InvalidCurrentPlanError("The current Clanky plan file is empty.");
    }
    throw new InvalidCurrentPlanError(`The selected plan file "${source.displayPath}" is empty.`);
  }

  const rawStatusContent = source.statusPath === source.planPath
    ? null
    : await executor.readFile(source.statusPath);
  const statusContent = rawStatusContent?.trim() ? rawStatusContent : undefined;
  return {
    planContent,
    statusContent,
    planSourcePath: rawPlanContent === planContent ? source.planPath : undefined,
    statusSourcePath: statusContent !== undefined && rawStatusContent === statusContent ? source.statusPath : undefined,
  };
}

export function buildSeededPlanStatusContent(taskName: string): string {
  const safeTaskName = sanitizeTaskNameForStatusContent(taskName) || "this task";
  return `# Status

## Current state

- Imported plan ready for ${safeTaskName}
- Current task: review the imported plan and either accept it or send feedback
- Notes: This task was spawned from the chat's current Clanky plan

## Next steps

1. Review \`plan.md\`.
2. Accept the plan to start execution, or send feedback to refine it.
3. Keep this file updated as work progresses.`;
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

  const planWritten = await writePlanningFile(
    executor,
    files.planSourcePath,
    getPlanFilePath(directory),
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
    files.statusSourcePath,
    getStatusFilePath(directory),
    nextStatusContent,
  );
  if (!statusWritten) {
    throw new Error("Failed to write status.md for the seeded task");
  }
}

async function writePlanningFile(
  executor: CommandExecutor,
  sourcePath: string | undefined,
  destinationPath: string,
  content: string,
): Promise<boolean> {
  if (sourcePath && executor.copyFile) {
    const copied = await executor.copyFile(sourcePath, destinationPath);
    if (copied) {
      return true;
    }
  }

  if (executor.writeFileStream) {
    const result = await executor.writeFileStream(destinationPath, new Blob([content]).stream());
    return result.success;
  }

  return await executor.writeFile(destinationPath, content);
}
