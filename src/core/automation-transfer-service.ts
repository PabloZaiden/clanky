import type { AutomationTransferPayload } from "@/contracts/schemas";
import type { Automation } from "@/shared/automation";
import { getWorkspace } from "../persistence/workspaces";
import { automationManager } from "./automation-manager";
import { DomainError } from "../domain/domain-error";
import { isGitBackedWorkspace } from "./workspace-capabilities";

const AUTOMATION_TRANSFER_FORMAT = "clanky-automation" as const;
const AUTOMATION_TRANSFER_VERSION = 1 as const;

export function createAutomationTransferPayload(automation: Automation): AutomationTransferPayload {
  return {
    format: AUTOMATION_TRANSFER_FORMAT,
    version: AUTOMATION_TRANSFER_VERSION,
    automation: {
      name: automation.config.name,
      prompt: automation.config.prompt,
      ...(automation.config.code === undefined ? {} : { code: automation.config.code }),
      model: automation.config.model,
      ...(automation.config.baseBranch === undefined ? {} : { baseBranch: automation.config.baseBranch }),
      useWorktree: automation.config.useWorktree,
      schedule: {
        startAtLocal: automation.config.schedule.startAtLocal,
        timezone: automation.config.schedule.timezone,
        interval: automation.config.schedule.interval,
      },
    },
  };
}

export async function exportAutomationConfig(automationId: string): Promise<AutomationTransferPayload | null> {
  const automation = await automationManager.getAutomation(automationId);
  return automation ? createAutomationTransferPayload(automation) : null;
}

export function getAutomationTransferFilename(name: string): string {
  const normalizedName = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${normalizedName || "automation"}.clanky-automation.json`;
}

export async function importAutomationConfig(
  workspaceId: string,
  payload: AutomationTransferPayload,
): Promise<Automation> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", "Workspace not found", {
      details: { workspaceId },
    });
  }

  const isGitWorkspace = isGitBackedWorkspace(workspace);
  return await automationManager.createAutomation({
    name: payload.automation.name,
    workspaceId,
    prompt: payload.automation.prompt,
    code: payload.automation.code,
    model: payload.automation.model,
    baseBranch: isGitWorkspace ? payload.automation.baseBranch : undefined,
    useWorktree: isGitWorkspace ? payload.automation.useWorktree : false,
    schedule: payload.automation.schedule,
    enabled: false,
  });
}
