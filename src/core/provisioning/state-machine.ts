import type { ProvisioningJobStatus } from "@/shared";

const TRANSITION_TABLE: Record<
  ProvisioningJobStatus,
  ReadonlySet<ProvisioningJobStatus>
> = {
  pending: new Set(["running", "not_started", "connection_failed", "failed", "cancelled", "interrupted", "unconfirmed"]),
  running: new Set(["verifying", "completed", "not_started", "connection_failed", "failed", "cancelled", "interrupted", "unconfirmed"]),
  verifying: new Set(["completed", "cancelled", "unconfirmed"]),
  completed: new Set(),
  not_started: new Set(),
  connection_failed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
  unconfirmed: new Set(),
};

export function isValidProvisioningTransition(
  from: ProvisioningJobStatus,
  to: ProvisioningJobStatus,
): boolean {
  return from === to || TRANSITION_TABLE[from].has(to);
}

export function assertValidProvisioningTransition(
  from: ProvisioningJobStatus,
  to: ProvisioningJobStatus,
  context?: string,
): void {
  if (isValidProvisioningTransition(from, to)) {
    return;
  }

  const suffix = context ? ` (${context})` : "";
  throw new Error(`Invalid provisioning job status transition: ${from} -> ${to}${suffix}`);
}

export function getValidProvisioningTransitions(
  from: ProvisioningJobStatus,
): ReadonlySet<ProvisioningJobStatus> {
  return TRANSITION_TABLE[from] ?? new Set();
}
