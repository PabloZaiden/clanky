import type {
  AgentStatus,
  ChatStatus,
  ProvisioningJobStatus,
  TerminalSessionStatus,
  WorkerUpdateJobStatus,
  WorkerUpdateStepStatus,
} from "@/shared";
import type { BadgeVariant } from "@pablozaiden/webapp/web";

export function getChatStatusBadgeVariant(status: ChatStatus): BadgeVariant {
  switch (status) {
    case "starting":
    case "streaming":
    case "reconnecting":
      return "info";
    case "interrupting":
    case "waiting":
      return "warning";
    case "failed":
      return "error";
    case "stopped":
      return "stopped";
    case "done":
      return "completed";
    case "idle":
    default:
      return "success";
  }
}

export function getAgentStatusBadgeVariant(status: AgentStatus | string): BadgeVariant {
  switch (status) {
    case "enabled":
    case "completed":
      return "success";
    case "running":
    case "starting":
    case "scheduled":
      return "info";
    case "failed":
    case "error":
      return "error";
    case "paused":
    case "skipped":
    case "interrupted":
    case "cancelled":
      return "warning";
    default:
      return "default";
  }
}

export function getTerminalSessionStatusBadgeVariant(status: TerminalSessionStatus): BadgeVariant {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
      return "info";
    case "failed":
      return "error";
    case "disconnected":
      return "warning";
    case "ready":
    default:
      return "default";
  }
}

export function getTerminalSessionStatusLabel(status: TerminalSessionStatus): string {
  switch (status) {
    case "connected": return "Connected";
    case "connecting": return "Connecting";
    case "disconnected": return "Disconnected";
    case "failed": return "Failed";
    case "ready": return "Ready";
  }
}

export function getProvisioningStatusBadgeVariant(status: ProvisioningJobStatus): BadgeVariant {
  switch (status) {
    case "running":
    case "verifying":
    case "pending": return "running";
    case "completed": return "completed";
    case "failed":
    case "connection_failed": return "failed";
    case "not_started":
    case "unconfirmed":
    case "cancelled": return "warning";
    case "interrupted": return "warning";
  }
}

export function getProvisioningStatusLabel(status: ProvisioningJobStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "verifying": return "Verifying recovery";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "connection_failed": return "Could not connect";
    case "not_started": return "Not started";
    case "unconfirmed": return "Outcome unconfirmed";
    case "cancelled": return "Cancelled";
    case "interrupted": return "Interrupted";
  }
}

export function getWorkerUpdateStatusBadgeVariant(status: WorkerUpdateJobStatus): BadgeVariant {
  switch (status) {
    case "pending":
    case "connecting":
    case "running":
    case "verifying":
      return "running";
    case "completed":
      return "completed";
    case "connection_failed":
    case "failed":
      return "failed";
    case "interrupted":
    case "not_started":
    case "unconfirmed":
      return "warning";
  }
}

export function getWorkerUpdateStatusLabel(status: WorkerUpdateJobStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "connecting": return "Connecting";
    case "running": return "Running";
    case "verifying": return "Verifying restart";
    case "completed": return "Completed";
    case "not_started": return "Not started";
    case "connection_failed": return "Could not connect";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "unconfirmed": return "Outcome unconfirmed";
  }
}

export function getWorkerUpdateStepStatusBadgeVariant(status: WorkerUpdateStepStatus): BadgeVariant {
  switch (status) {
    case "pending":
      return "default";
    case "running":
    case "connecting":
    case "verifying":
      return "running";
    case "succeeded":
      return "completed";
    case "connection_failed":
    case "failed":
      return "failed";
    case "skipped":
    case "not_started":
    case "interrupted":
    case "unconfirmed":
      return "warning";
  }
}

export function getWorkerUpdateStepStatusLabel(status: WorkerUpdateStepStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "connecting": return "Connecting";
    case "running": return "Running";
    case "verifying": return "Verifying";
    case "succeeded": return "Succeeded";
    case "not_started": return "Not started";
    case "connection_failed": return "Could not connect";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "skipped": return "Skipped";
    case "unconfirmed": return "Outcome unconfirmed";
  }
}
