/**
 * Pure transition decisions for controller-worker mesh enrollment.
 *
 * This module never reads or writes storage and never performs transport work.
 * The enrollment model is simpler than the old pairing model: there is no
 * multi-step approve/complete flow. A token-based enrollment either succeeds
 * atomically or fails.
 */

import type { MeshControllerGrant, MeshWorkerRegistration } from "@/shared/mesh";
import { DomainError } from "./domain-error";

export interface EnrollWorkerTransitionInput {
  existingRegistration: MeshWorkerRegistration | null;
  workerNodeId: string;
  localNodeId: string;
}

export type EnrollWorkerDecision =
  | { kind: "apply" }
  | { kind: "idempotent" };

export function decideEnrollWorker(
  input: EnrollWorkerTransitionInput,
): EnrollWorkerDecision {
  if (input.workerNodeId === input.localNodeId) {
    throw new DomainError(
      "mesh_enrollment_self",
      "A node cannot enroll itself as a worker.",
    );
  }
  if (input.existingRegistration) {
    if (input.existingRegistration.grantStatus === "active") {
      return { kind: "idempotent" };
    }
    // Re-enroll a revoked worker
    return { kind: "apply" };
  }
  return { kind: "apply" };
}

export interface RevokeWorkerTransitionInput {
  registration: MeshWorkerRegistration | null;
}

export type RevokeWorkerDecision =
  | { kind: "apply" }
  | { kind: "idempotent" };

export function decideRevokeWorker(
  input: RevokeWorkerTransitionInput,
): RevokeWorkerDecision {
  if (!input.registration) {
    throw new DomainError(
      "mesh_worker_not_found",
      "The worker registration was not found.",
    );
  }
  if (input.registration.grantStatus === "revoked") {
    return { kind: "idempotent" };
  }
  return { kind: "apply" };
}

export interface AcceptEnrollmentTransitionInput {
  existingGrant: MeshControllerGrant | null;
  controllerNodeId: string;
  localNodeId: string;
}

export type AcceptEnrollmentDecision =
  | { kind: "apply" }
  | { kind: "idempotent" };

export function decideAcceptEnrollment(
  input: AcceptEnrollmentTransitionInput,
): AcceptEnrollmentDecision {
  if (input.controllerNodeId === input.localNodeId) {
    throw new DomainError(
      "mesh_enrollment_self",
      "A node cannot enroll with itself as a controller.",
    );
  }
  if (input.existingGrant) {
    if (input.existingGrant.grantStatus === "active") {
      return { kind: "idempotent" };
    }
    // Re-accept from a previously revoked controller
    return { kind: "apply" };
  }
  return { kind: "apply" };
}
