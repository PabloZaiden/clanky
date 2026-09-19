import type { ProvisioningJobStatus } from "@/shared";

const TRANSITION_TABLE: Record<
  ProvisioningJobStatus,
  ReadonlySet<ProvisioningJobStatus>
> = {
  pending: new Set(["running", "failed", "cancelled", "interrupted"]),
  running: new Set(["completed", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
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
