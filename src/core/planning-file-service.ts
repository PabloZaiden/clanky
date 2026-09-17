import {
  resolveCommandExecutorDirectory,
  type CommandExecutor,
} from "./command-executor";
import { ensurePlanningDirectory } from "./planning-directory";
import {
  dirnameExecutionPath,
  isAbsoluteExecutionPath,
  joinExecutionPath,
  normalizeExecutionPath,
  resolveExecutionPathWithinDirectory,
} from "./execution-path";
import {
  DEFAULT_PLAN_DISPLAY_PATH,
  ManagedPathService,
  STATUS_FILE_NAME,
} from "./managed-path-service";
import { InvalidCurrentPlanError } from "@/shared/chat";

const PLAN_READY_MARKER = /<promise>PLAN_READY<\/promise>/gi;

export interface ValidatedPlanningFiles {
  planContent: string;
  statusContent?: string;
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

function resolvePlanningFileSource(
  directory: string,
  pathStyle: CommandExecutor["pathStyle"],
  requestedPlanPath?: string,
): PlanningFileSource {
  const managedPaths = new ManagedPathService(pathStyle);
  const trimmedPlanPath = requestedPlanPath?.trim() ?? "";
  if (!trimmedPlanPath) {
    return {
      planPath: managedPaths.getPlanFilePath(directory),
      statusPath: managedPaths.getStatusFilePath(directory),
      displayPath: DEFAULT_PLAN_DISPLAY_PATH,
      isDefault: true,
    };
  }

  let normalizedRequestedPath: string;
  try {
    normalizedRequestedPath = normalizeExecutionPath(trimmedPlanPath, pathStyle);
  } catch (error) {
    throw new InvalidCurrentPlanError(
      "The selected plan file path is invalid for the workspace host.",
      { cause: error },
    );
  }
  if (
    !normalizedRequestedPath
    || normalizedRequestedPath === "."
    || normalizedRequestedPath === "/"
    || normalizedRequestedPath === "\\"
  ) {
    throw new InvalidCurrentPlanError("The selected plan file path must point to a plan file.");
  }
  const isAbsolutePlanPath = isAbsoluteExecutionPath(
    normalizedRequestedPath,
    pathStyle,
  );
  let planPath: string;
  try {
    planPath = isAbsolutePlanPath
    ? normalizedRequestedPath
    : resolveExecutionPathWithinDirectory(
        directory,
        normalizedRequestedPath,
        pathStyle,
      );
  } catch (error) {
    throw new InvalidCurrentPlanError(
      "Relative plan file paths must stay within the current chat workspace.",
      { cause: error },
    );
  }

  return {
    planPath,
    statusPath: joinExecutionPath(
      pathStyle,
      dirnameExecutionPath(planPath, pathStyle),
      STATUS_FILE_NAME,
    ),
    displayPath: sanitizePlanPathForMessage(normalizedRequestedPath),
    isDefault: false,
  };
}

export async function readValidatedPlanningFiles(
  executor: CommandExecutor,
  directory: string,
  requestedPlanPath?: string,
): Promise<ValidatedPlanningFiles> {
  const executionDirectory = await resolveCommandExecutorDirectory(
    executor,
    directory,
  );
  const source = resolvePlanningFileSource(
    executionDirectory,
    executor.pathStyle,
    requestedPlanPath,
  );
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
  const normalizedStatusContent = rawStatusContent?.trim();
  const statusContent = normalizedStatusContent ? normalizedStatusContent : undefined;
  return {
    planContent,
    statusContent,
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
