import type { ProvisioningCommandExecution, ProvisioningStep } from "@/shared";

const STEP_LABELS: Record<ProvisioningStep, string> = {
  verify_environment: "Verify environment",
  prepare_directory: "Prepare directory",
  clone_repo: "Prepare repository",
  environment_up: "Start environment",
  environment_rebuild: "Rebuild environment",
  environment_restart: "Restart environment",
  environment_arise: "Update server",
  environment_status: "Check environment status",
  create_workspace: "Create workspace",
  test_connection: "Test connection",
  workspace_ready: "Workspace ready",
  arise_complete: "Server update complete",
};

export function getProvisioningStepLabel(step?: ProvisioningStep): string {
  return step ? STEP_LABELS[step] : "Waiting to start";
}

export function getProvisioningExecutionLabel(execution: ProvisioningCommandExecution): string {
  switch (execution.outcome) {
    case "succeeded": return "Succeeded";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "unconfirmed": return "Outcome unconfirmed";
  }
  switch (execution.state) {
    case "not_started": return "Not started";
    case "dispatched": return "Starting";
    case "started": return "Running";
    case "finished": return "Finished";
  }
}
