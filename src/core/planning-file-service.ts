import type { CommandExecutor } from "./command-executor";
import { ensurePlanningDirectory } from "./planning-directory";
import { getPlanFilePath, getStatusFilePath } from "../lib/planning-files";
import { InvalidCurrentPlanError } from "../types/chat";

const PLAN_READY_MARKER = /<promise>PLAN_READY<\/promise>/gi;

export interface ValidatedPlanningFiles {
  planContent: string;
  statusContent?: string;
}

function normalizePlanContent(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(PLAN_READY_MARKER, "").trim();
}

function hasMeaningfulPlanContent(content: string): boolean {
  return normalizePlanContent(content).length > 0;
}

function sanitizeLoopNameForStatusContent(loopName: string): string {
  return loopName
    .replace(/[`]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readValidatedPlanningFiles(
  executor: CommandExecutor,
  directory: string,
): Promise<ValidatedPlanningFiles> {
  const planPath = getPlanFilePath(directory);
  const rawPlanContent = await executor.readFile(planPath);
  if (rawPlanContent === null) {
    throw new InvalidCurrentPlanError("No Ralpher plan file was found in the current chat workspace.");
  }
  const planContent = normalizePlanContent(rawPlanContent);
  if (!hasMeaningfulPlanContent(rawPlanContent)) {
    throw new InvalidCurrentPlanError("The current Ralpher plan file is empty.");
  }

  const statusContent = await executor.readFile(getStatusFilePath(directory));
  return {
    planContent,
    statusContent: statusContent?.trim() ? statusContent : undefined,
  };
}

export function buildSeededPlanStatusContent(loopName: string): string {
  const safeLoopName = sanitizeLoopNameForStatusContent(loopName) || "this loop";
  return `# Status

## Current state

- Imported plan ready for ${safeLoopName}
- Current task: review the imported plan and either accept it or send feedback
- Notes: This loop was spawned from the chat's current Ralpher plan

## Next steps

1. Review \`plan.md\`.
2. Accept the plan to start execution, or send feedback to refine it.
3. Keep this file updated as work progresses.`;
}

export async function writePlanningFiles(
  executor: CommandExecutor,
  directory: string,
  files: ValidatedPlanningFiles,
): Promise<void> {
  await ensurePlanningDirectory(executor, directory);

  const planWritten = await executor.writeFile(getPlanFilePath(directory), files.planContent);
  if (!planWritten) {
    throw new Error("Failed to write plan.md for the seeded loop");
  }

  const nextStatusContent = files.statusContent?.trim();
  if (!nextStatusContent) {
    return;
  }

  const statusWritten = await executor.writeFile(getStatusFilePath(directory), nextStatusContent);
  if (!statusWritten) {
    throw new Error("Failed to write status.md for the seeded loop");
  }
}
