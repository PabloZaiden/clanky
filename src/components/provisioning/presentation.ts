import type { ProvisioningCommandExecution, ProvisioningStep } from "@/shared";

const STEP_LABELS: Record<ProvisioningStep, string> = {
  verify_devbox: "Verify devbox",
  prepare_directory: "Prepare directory",
  clone_repo: "Prepare repository",
  devbox_up: "Start devbox",
  devbox_rebuild: "Rebuild devbox",
  devbox_arise: "Update server",
  devbox_status: "Check devbox status",
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
