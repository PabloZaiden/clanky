/**
 * Coordinates the lifecycle of workspace-exclusive Mesh worker reservations.
 *
 * Remote revocation remains owned by MeshManager; this service owns the
 * reservation state and its private execution-host binding.
 */

import type { ExecutionHostBinding } from "@/shared/execution-host";
import type { MeshWorkerRegistration } from "@/shared/mesh";
import {
  getWorkerRegistrationByEnrollment,
  getWorkerRegistrationByWorkspace,
  getWorkerRegistrationExecutionHostRef,
  moveDedicatedWorkerToWorkspace,
} from "../persistence/mesh";
import {
  getExecutionHostByRef,
  toExecutionHostBinding,
} from "../persistence/execution-hosts";
import {
  attachWorkspaceWorkerEnrollment,
  claimWorkspaceWorkerEnrollment,
  createWorkspaceWorkerEnrollment,
  failWorkspaceWorkerEnrollment,
  getWorkspaceWorkerEnrollment,
  getWorkspaceWorkerEnrollmentByWorkspace,
  listWorkspaceWorkerEnrollments,
  markWorkspaceWorkerConnected,
  type CreatedWorkspaceWorkerEnrollment,
  type WorkspaceWorkerEnrollment,
} from "../persistence/workspace-worker-enrollments";
import { DomainError } from "./domain-error";

function isExpired(enrollment: WorkspaceWorkerEnrollment): boolean {
  return Date.parse(enrollment.expiresAt) <= Date.now();
}

function requireEnrollment(
  userId: string,
  enrollmentId: string,
): WorkspaceWorkerEnrollment {
  const enrollment = getWorkspaceWorkerEnrollment(userId, enrollmentId);
  if (!enrollment) {
    throw new DomainError(
      "workspace_worker_enrollment_not_found",
      "Workspace worker enrollment not found.",
    );
  }
  return enrollment;
}

function requireRegistration(
  enrollment: WorkspaceWorkerEnrollment,
  registration: MeshWorkerRegistration | null,
): MeshWorkerRegistration {
  if (!registration || registration.grantStatus !== "active") {
    throw new DomainError(
      "workspace_worker_not_connected",
      "The workspace worker has not connected.",
      { details: { enrollmentId: enrollment.id } },
    );
  }
  return registration;
}

export interface WorkspaceWorkerEnrollmentStatus {
  enrollment: WorkspaceWorkerEnrollment;
  worker: MeshWorkerRegistration | null;
}

export class WorkspaceWorkerEnrollmentService {
  create(
    userId: string,
    input: {
      name: string;
      ttlSeconds: number;
      controller: { nodeId: string; fingerprint: string };
    },
  ): CreatedWorkspaceWorkerEnrollment {
    return createWorkspaceWorkerEnrollment({
      userId,
      ...input,
    });
  }

  getStatus(
    userId: string,
    enrollmentId: string,
  ): WorkspaceWorkerEnrollmentStatus {
    let enrollment = requireEnrollment(userId, enrollmentId);
    if (
      isExpired(enrollment)
      && !["attached", "cancelled", "expired", "failed"].includes(enrollment.status)
    ) {
      failWorkspaceWorkerEnrollment({
        userId,
        enrollmentId,
        status: "expired",
        errorCode: "enrollment_expired",
        errorMessage: "The workspace worker enrollment expired.",
      });
      enrollment = requireEnrollment(userId, enrollmentId);
    }

    return {
      enrollment,
      worker: enrollment.workerNodeId
        ? getWorkerRegistrationByEnrollment(enrollmentId, userId)
        : null,
    };
  }

  list(userId: string): WorkspaceWorkerEnrollmentStatus[] {
    return listWorkspaceWorkerEnrollments(userId).map((enrollment) => ({
      enrollment,
      worker: enrollment.workerNodeId
        ? getWorkerRegistrationByEnrollment(enrollment.id, userId)
        : null,
    }));
  }

  markConnected(
    userId: string,
    enrollmentId: string,
    workerNodeId: string,
  ): WorkspaceWorkerEnrollment {
    try {
      return markWorkspaceWorkerConnected({
        userId,
        enrollmentId,
        workerNodeId,
      });
    } catch (error) {
      throw new DomainError(
        "workspace_worker_enrollment_unavailable",
        "The workspace worker enrollment is no longer available.",
        { cause: error },
      );
    }
  }

  getExecutionHostBinding(
    userId: string,
    enrollmentId: string,
  ): ExecutionHostBinding {
    const enrollment = requireEnrollment(userId, enrollmentId);
    if (isExpired(enrollment)) {
      throw new DomainError(
        "workspace_worker_enrollment_expired",
        "The workspace worker enrollment expired.",
      );
    }
    if (!["connected", "claimed", "attached"].includes(enrollment.status)) {
      throw new DomainError(
        "workspace_worker_enrollment_unavailable",
        "The workspace worker enrollment is not ready for execution.",
      );
    }
    const registration = requireRegistration(
      enrollment,
      enrollment.workerNodeId
        ? getWorkerRegistrationByEnrollment(enrollmentId, userId)
        : null,
    );
    const hostRef = getWorkerRegistrationExecutionHostRef(registration);
    const host = getExecutionHostByRef(userId, hostRef);
    if (!host || host.revokedAt) {
      throw new DomainError(
        "execution_host_unavailable",
        "The workspace worker execution host is unavailable.",
      );
    }
    return toExecutionHostBinding(host);
  }

  claimForProvisioning(
    userId: string,
    enrollmentId: string,
    jobId: string,
  ): ExecutionHostBinding {
    const enrollment = requireEnrollment(userId, enrollmentId);
    if (enrollment.workspaceId) {
      throw new DomainError(
        "workspace_worker_already_attached",
        "The workspace worker is already associated with a workspace.",
      );
    }
    try {
      claimWorkspaceWorkerEnrollment({
        userId,
        enrollmentId,
        claimedBy: jobId,
      });
    } catch (error) {
      throw new DomainError(
        "workspace_worker_enrollment_claimed",
        "The workspace worker enrollment is already being used.",
        { cause: error },
      );
    }
    return this.getExecutionHostBinding(userId, enrollmentId);
  }

  claimForWorkspace(
    userId: string,
    enrollmentId: string,
    workspaceId: string,
    claimId: string = workspaceId,
    previousClaimId?: string,
  ): ExecutionHostBinding {
    const enrollment = requireEnrollment(userId, enrollmentId);
    if (enrollment.status === "attached" && enrollment.workspaceId === workspaceId) {
      return this.getExecutionHostBinding(userId, enrollmentId);
    }
    try {
      claimWorkspaceWorkerEnrollment({
        userId,
        enrollmentId,
        claimedBy: claimId,
        workspaceId,
        previousClaimedBy: previousClaimId,
      });
    } catch (error) {
      throw new DomainError(
        "workspace_worker_enrollment_claimed",
        "The workspace worker enrollment is already being used.",
        { cause: error },
      );
    }
    const current = requireEnrollment(userId, enrollmentId);
    const registration = requireRegistration(
      current,
      current.workerNodeId
        ? getWorkerRegistrationByEnrollment(enrollmentId, userId)
        : null,
    );
    if (current.workspaceId !== workspaceId) {
      throw new DomainError(
        "workspace_worker_workspace_mismatch",
        "The workspace worker enrollment belongs to another workspace.",
      );
    }
    return moveDedicatedWorkerToWorkspace({
      workerNodeId: registration.workerNodeId,
      localUserId: userId,
      enrollmentId,
      workspaceId,
    });
  }

  attach(
    userId: string,
    enrollmentId: string,
    workspaceId: string,
    claimId: string = workspaceId,
  ): WorkspaceWorkerEnrollment {
    try {
      return attachWorkspaceWorkerEnrollment({
        userId,
        enrollmentId,
        workspaceId,
        claimedBy: claimId,
      });
    } catch (error) {
      throw new DomainError(
        "workspace_worker_attach_failed",
        "The workspace worker could not be attached to the workspace.",
        { cause: error },
      );
    }
  }

  getByWorkspace(
    userId: string,
    workspaceId: string,
  ): WorkspaceWorkerEnrollmentStatus | null {
    const enrollment = getWorkspaceWorkerEnrollmentByWorkspace(userId, workspaceId);
    if (!enrollment) {
      return null;
    }
    return {
      enrollment,
      worker: getWorkerRegistrationByWorkspace(workspaceId, userId),
    };
  }

  markFailed(
    userId: string,
    enrollmentId: string,
    errorCode: string,
    errorMessage: string,
    status: "cancelled" | "expired" | "failed" = "failed",
    allowAttached = false,
  ): void {
    failWorkspaceWorkerEnrollment({
      userId,
      enrollmentId,
      status,
      errorCode,
      errorMessage,
      allowAttached,
    });
  }
}

export const workspaceWorkerEnrollmentService =
  new WorkspaceWorkerEnrollmentService();
