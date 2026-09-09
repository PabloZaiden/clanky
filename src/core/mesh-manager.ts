/**
 * Core orchestration for the controller-worker mesh.
 *
 * Controllers enroll workers via single-use tokens. Workers store independent
 * grants. No membership gossip, no roster propagation, no peer-to-peer
 * relationships.
 */

import type {
  MeshEnrollmentRequest,
  MeshEnrollmentResponse,
  MeshHealthCheck,
  MeshHealthCheckResponse,
  MeshRevocationNotice,
  MeshWorkerKillRequest,
} from "@/contracts/schemas/mesh";
import { MeshHealthCheckResponseSchema } from "@/contracts/schemas/mesh";
import type {
  MeshControllerGrant,
  MeshControllerStatus,
  MeshNodeIdentity,
  MeshWorkerExecutionConfig,
  MeshWorkerStatus,
} from "@/shared/mesh";
import { MESH_WORKER_KILL_REQUEST_TTL_MS } from "@/shared/mesh";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "@/shared/execution-host";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  getControllerGrant,
  getWorkerRegistration,
  getWorkerRegistrationByEnrollment,
  getWorkerRegistrationByWorkspace,
  listActiveWorkerRegistrations,
  listControllerGrants,
  listWorkerRegistrations,
  revokeControllerGrant,
  revokeWorkerRegistration,
  deleteRevokedWorkerRegistration,
  claimMeshWorkerKillNonce,
  saveControllerGrant,
  saveWorkerRegistration,
  updateWorkerHealthSnapshot,
} from "../persistence/mesh";
import {
  deleteExecutionHost,
  getExecutionHostByRef,
} from "../persistence/execution-hosts";
import {
  consumeMeshEnrollmentToken,
  createMeshEnrollmentToken,
  listMeshEnrollmentTokens,
} from "../persistence/mesh-enrollment-tokens";
import { workspaceWorkerEnrollmentService } from "./workspace-worker-enrollment-service";
import {
  ensureLocalMeshNodeIdentity,
  requireMeshInstanceName,
  setLocalMeshEndpoint,
  setLocalMeshInstanceName,
  signMeshPayload,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import {
  assertMeshWorkerTlsCertificate,
  getMeshWorkerTlsIdentity,
} from "../persistence/mesh-worker-tls";
import {
  buildMeshEnrollmentRequestSigningPayload,
  buildMeshEnrollmentResponseSigningPayload,
  buildMeshHealthCheckSigningPayload,
  buildMeshHealthCheckResponseSigningPayload,
  buildMeshRevocationNoticeSigningPayload,
  buildMeshWorkerKillRequestSigningPayload,
} from "./mesh-protocol";
import {
  assertMeshEndpointAllowed,
  getMeshTransport,
  resolveAdvertisedMeshEndpoint,
  resolveMeshRoute,
} from "./mesh-transport-config";
import { DomainError, isDomainError } from "./domain-error";
import { postMeshControlMessage } from "./mesh-control-client";
import { getMeshWorkerTlsOptions } from "./mesh-peer-tls";
import { assertMeshPeerIdentity } from "./mesh-peer-auth";
import {
  decideEnrollWorker,
  decideRevokeWorker,
  decideAcceptEnrollment,
} from "../domain/mesh-transitions";
import { buildWorkerJoinCommand } from "./mesh-join-command";
import { meshStateEventEmitter } from "./event-emitter";
import {
  getMeshRuntimeRole,
  getMeshWorkerDirectory,
  isMeshWorkerExecutionEnabled,
  requireMeshRuntimeRole,
} from "./mesh-runtime";

const log = createLogger("core:mesh-manager");
const MESH_WORKER_KILL_DELAY_MS = 100;
const MESH_WORKER_KILL_EXIT_CODE = 1;

async function ensureLocalMeshIdentityWithEndpoint(): Promise<MeshNodeIdentity> {
  const identity = await ensureLocalMeshNodeIdentity();
  if (identity.meshEndpoint !== null || !process.env["CLANKY_PUBLIC_BASE_URL"]?.trim()) {
    return identity;
  }
  const endpoint = resolveAdvertisedMeshEndpoint();
  const updatedIdentity = await setLocalMeshEndpoint(endpoint);
  log.info("Materialized the configured public base URL as the local Mesh endpoint", {
    endpoint,
  });
  return updatedIdentity;
}

export class MeshManager {
  // --- Controller: enrollment token management ---

  async createEnrollmentToken(
    userId: string,
    name: string,
    ttlSeconds: number,
  ) {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const controllerEndpoint = identity.meshEndpoint ?? resolveAdvertisedMeshEndpoint();
    const created = createMeshEnrollmentToken(userId, name, ttlSeconds, {
      nodeId: identity.nodeId,
      fingerprint: identity.fingerprint,
    });
    return {
      ...created,
      workerJoinCommand: buildWorkerJoinCommand({
        controllerEndpoint,
        enrollmentToken: created.token,
        controllerFingerprint: identity.fingerprint,
      }),
    };
  }

  async createWorkspaceWorkerEnrollment(
    userId: string,
    name: string,
    ttlSeconds: number,
  ) {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const controllerEndpoint = identity.meshEndpoint ?? resolveAdvertisedMeshEndpoint();
    const created = workspaceWorkerEnrollmentService.create(userId, {
      name,
      ttlSeconds,
      controller: {
        nodeId: identity.nodeId,
        fingerprint: identity.fingerprint,
      },
    });
    return {
      ...created,
      workerJoinCommand: buildWorkerJoinCommand({
        controllerEndpoint,
        enrollmentToken: created.token,
        controllerFingerprint: identity.fingerprint,
      }),
    };
  }

  async getWorkspaceWorkerEnrollment(userId: string, enrollmentId: string) {
    requireMeshRuntimeRole("controller");
    const status = workspaceWorkerEnrollmentService.getStatus(userId, enrollmentId);
    if (status.enrollment.status === "expired") {
      await this.cleanupDedicatedWorker(userId, enrollmentId);
      return workspaceWorkerEnrollmentService.getStatus(userId, enrollmentId);
    }
    return status;
  }

  async reconcileWorkspaceWorkerEnrollments(userId: string): Promise<void> {
    requireMeshRuntimeRole("controller");
    const now = Date.now();
    for (const status of workspaceWorkerEnrollmentService.list(userId)) {
      if (
        !["pending", "connected"].includes(status.enrollment.status)
        || Date.parse(status.enrollment.expiresAt) > now
      ) {
        continue;
      }
      try {
        workspaceWorkerEnrollmentService.markFailed(
          userId,
          status.enrollment.id,
          "enrollment_expired",
          "The workspace worker enrollment expired.",
          "expired",
          true,
        );
        await this.cleanupDedicatedWorker(userId, status.enrollment.id);
      } catch (error) {
        log.error("Failed to reconcile expired workspace worker enrollment", {
          enrollmentId: status.enrollment.id,
          error: String(error),
        });
      }
    }
  }

  async listWorkspaceWorkerEnrollments(userId: string) {
    requireMeshRuntimeRole("controller");
    await this.reconcileWorkspaceWorkerEnrollments(userId);
    return workspaceWorkerEnrollmentService.list(userId);
  }

  async cancelWorkspaceWorkerEnrollment(
    userId: string,
    enrollmentId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const status = workspaceWorkerEnrollmentService.getStatus(userId, enrollmentId);
    if (status.enrollment.status === "attached") {
      throw new DomainError(
        "workspace_worker_already_attached",
        "The workspace worker enrollment is already attached to a workspace.",
      );
    }
    await this.cleanupDedicatedWorker(userId, enrollmentId);
  }

  async listEnrollmentTokens(userId: string) {
    requireMeshRuntimeRole("controller");
    return listMeshEnrollmentTokens(userId);
  }

  // --- Controller: receive enrollment from worker ---

  async receiveEnrollmentRequest(
    envelope: MeshEnrollmentRequest,
  ): Promise<MeshEnrollmentResponse> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshNodeIdentity();

    // Verify the enrollment signature
    assertMeshPeerIdentity(
      envelope.workerPublicKey,
      envelope.workerFingerprint,
      "enrolling worker",
    );
    const signingPayload = buildMeshEnrollmentRequestSigningPayload(envelope);
    const signatureValid = await verifyMeshPayloadSignature(
      signingPayload,
      envelope.signature,
      envelope.workerPublicKey,
    );
    if (!signatureValid) {
      throw new DomainError(
        "mesh_enrollment_invalid_signature",
        "The enrollment request signature is invalid.",
      );
    }

    // Verify the worker is enrolling against the correct controller
    if (envelope.expectedControllerFingerprint !== identity.fingerprint) {
      throw new DomainError(
        "mesh_enrollment_controller_mismatch",
        "The expected controller fingerprint does not match this node.",
      );
    }

    // Verify request is not expired
    if (Date.parse(envelope.expiresAt) <= Date.now()) {
      throw new DomainError(
        "mesh_enrollment_expired",
        "The enrollment request has expired.",
      );
    }
    if (envelope.workerTransport === "https") {
      if (!envelope.workerTlsCertificate || !envelope.workerTlsFingerprint) {
        throw new DomainError(
          "mesh_enrollment_tls_identity_missing",
          "HTTPS workers must provide a TLS certificate and fingerprint.",
        );
      }
      assertMeshWorkerTlsCertificate(
        envelope.workerTlsCertificate,
        envelope.workerEndpoint,
        envelope.workerTlsFingerprint,
      );
    } else if (envelope.workerTlsCertificate || envelope.workerTlsFingerprint) {
      throw new DomainError(
        "mesh_enrollment_tls_identity_unexpected",
        "HTTP workers must not provide TLS trust material.",
      );
    }

    // Consume the enrollment token atomically
    const tokenResult = consumeMeshEnrollmentToken(
      envelope.enrollmentToken,
      {
        nodeId: identity.nodeId,
        fingerprint: identity.fingerprint,
      },
    );
    if (!tokenResult) {
      throw new DomainError(
        "mesh_enrollment_token_invalid",
        "The Mesh enrollment token is invalid, expired, or already used.",
      );
    }

    // Decide whether to apply enrollment
    const existingRegistration = await getWorkerRegistration(
      envelope.workerNodeId,
      tokenResult.userId,
    );
    if (
      tokenResult.purpose === "workspace-worker"
      && !tokenResult.workspaceWorkerEnrollmentId
    ) {
      throw new DomainError(
        "workspace_worker_enrollment_invalid",
        "The dedicated worker enrollment token is not linked to a reservation.",
      );
    }
    if (
      tokenResult.purpose === "workspace-worker"
      && existingRegistration
      && (
        existingRegistration.grantStatus === "active"
        || existingRegistration.registrationScope === "global"
      )
    ) {
      throw new DomainError(
        "workspace_worker_already_registered",
        "This worker is already registered as a general Mesh worker.",
      );
    }
    if (
      tokenResult.purpose === "global"
      && existingRegistration?.registrationScope === "workspace"
      && existingRegistration.grantStatus === "active"
    ) {
      throw new DomainError(
        "workspace_worker_workspace_scoped",
        "A workspace-dedicated worker cannot be used as a general server.",
      );
    }
    const decision = decideEnrollWorker({
      existingRegistration,
      workerNodeId: envelope.workerNodeId,
      localNodeId: identity.nodeId,
    });

    if (decision.kind === "apply") {
      const workspaceWorkerEnrollmentId = tokenResult.purpose === "workspace-worker"
        ? tokenResult.workspaceWorkerEnrollmentId!
        : undefined;
      try {
        await saveWorkerRegistration({
          workerNodeId: envelope.workerNodeId,
          localUserId: tokenResult.userId,
          workerInstanceName: envelope.workerInstanceName ?? null,
          workerEndpoint: envelope.workerEndpoint,
          workerTransport: envelope.workerTransport,
          workerPublicKey: envelope.workerPublicKey,
          workerFingerprint: envelope.workerFingerprint,
          workerEncryptionPublicKey: envelope.workerEncryptionPublicKey ?? null,
          workerTlsCertificate: envelope.workerTlsCertificate,
          workerTlsFingerprint: envelope.workerTlsFingerprint,
          workerDirectory: envelope.workerDirectory,
          workerCapabilities: envelope.workerCapabilities,
          workerAcceptRemoteExecution: envelope.workerAcceptRemoteExecution,
          workerConfigRevision: envelope.workerConfigRevision,
          ...(workspaceWorkerEnrollmentId
            ? {
                registrationScope: "workspace" as const,
                workspaceWorkerEnrollmentId,
              }
            : {}),
        });
        if (workspaceWorkerEnrollmentId) {
          workspaceWorkerEnrollmentService.markConnected(
            tokenResult.userId,
            workspaceWorkerEnrollmentId,
            envelope.workerNodeId,
          );
        }
      } catch (error) {
        if (workspaceWorkerEnrollmentId) {
          try {
            const savedRegistration = await getWorkerRegistration(
              envelope.workerNodeId,
              tokenResult.userId,
            );
            if (
              savedRegistration?.registrationScope === "workspace"
              && savedRegistration.workspaceWorkerEnrollmentId === workspaceWorkerEnrollmentId
            ) {
              await revokeWorkerRegistration(
                envelope.workerNodeId,
                tokenResult.userId,
              );
              await deleteRevokedWorkerRegistration(
                envelope.workerNodeId,
                tokenResult.userId,
              );
            }
          } catch (cleanupError) {
            log.error("Failed to clean up a partially enrolled workspace worker", {
              workerNodeId: envelope.workerNodeId,
              enrollmentId: workspaceWorkerEnrollmentId,
              error: String(cleanupError),
            });
          }
          try {
            workspaceWorkerEnrollmentService.markFailed(
              tokenResult.userId,
              workspaceWorkerEnrollmentId,
              "workspace_worker_connection_failed",
              "The workspace worker could not complete enrollment.",
            );
          } catch (statusError) {
            log.error("Failed to mark workspace worker enrollment as failed", {
              workerNodeId: envelope.workerNodeId,
              enrollmentId: workspaceWorkerEnrollmentId,
              error: String(statusError),
            });
          }
        }
        throw error;
      }
    }

    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged: true },
      { userId: tokenResult.userId },
    );

    const response: Omit<MeshEnrollmentResponse, "signature"> = {
      protocolVersion: 1,
      workerNodeId: envelope.workerNodeId,
      controllerNodeId: identity.nodeId,
      controllerInstanceName: identity.instanceName,
      controllerPublicKey: identity.publicKey,
      controllerFingerprint: identity.fingerprint,
      controllerEncryptionPublicKey: identity.encryptionPublicKey,
    };
    return {
      ...response,
      signature: await signMeshPayload(
        buildMeshEnrollmentResponseSigningPayload(response),
      ),
    };
  }

  // --- Controller: worker management ---

  async getControllerStatus(userId: string): Promise<MeshControllerStatus> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const workers = await listWorkerRegistrations(userId);
    return { node: identity, workers };
  }

  async revokeWorker(
    userId: string,
    workerNodeId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const registration = await getWorkerRegistration(workerNodeId, userId);
    const decision = decideRevokeWorker({ registration });

    const target = registration!;
    if (target.registrationScope === "workspace") {
      throw new DomainError(
        "workspace_worker_workspace_scoped",
        "Workspace-dedicated workers are revoked with their workspace.",
      );
    }

    if (decision.kind === "apply") {
      await revokeWorkerRegistration(workerNodeId, userId);
    }

    // The controller is authoritative. A worker may be offline, so failure to
    // prepare or deliver the signed notice must not undo the local revocation.
    try {
      const identity = await ensureLocalMeshNodeIdentity();
      const nonce = crypto.randomUUID();
      const expiresAt = new Date(
        Date.now() + 60_000,
      ).toISOString();
      const envelope: Omit<MeshRevocationNotice, "signature"> = {
        protocolVersion: 1,
        controllerNodeId: identity.nodeId,
        workerNodeId,
        controllerPublicKey: identity.publicKey,
        controllerFingerprint: identity.fingerprint,
        nonce,
        expiresAt,
      };
      const signature = await signMeshPayload(
        buildMeshRevocationNoticeSigningPayload(envelope),
      );
      const route = resolveMeshRoute(
        target.workerEndpoint,
        "api/mesh/internal/revocation",
      );
      await postMeshControlMessage(route, {
        ...envelope,
        signature,
      }, identity.nodeId, {
        headers: {
          "x-clanky-mesh-node-id": identity.nodeId,
        },
        tls: getMeshWorkerTlsOptions(target),
      });
    } catch (error) {
      if (isDomainError(error)) {
        log.warn("Worker remote revocation notice could not be prepared or delivered", {
          workerNodeId,
          errorCode: error.code,
          errorMessage: error.message,
          errorDetails: error.details,
        });
      } else {
        log.error("Unexpected worker remote revocation notice failure", {
          workerNodeId,
          error: String(error),
        });
      }
    }

    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged: true },
      { userId },
    );
  }

  async killWorker(
    userId: string,
    workerNodeId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const registration = await getWorkerRegistration(workerNodeId, userId);
    if (!registration) {
      throw new DomainError(
        "mesh_worker_not_found",
        "The worker registration was not found.",
      );
    }
    if (registration.grantStatus !== "active") {
      throw new DomainError(
        "mesh_peer_revoked",
        "The worker grant is revoked.",
      );
    }

    const identity = await ensureLocalMeshNodeIdentity();
    const nonce = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + MESH_WORKER_KILL_REQUEST_TTL_MS,
    ).toISOString();
    const envelope: Omit<MeshWorkerKillRequest, "signature"> = {
      protocolVersion: 1,
      controllerNodeId: identity.nodeId,
      workerNodeId,
      controllerPublicKey: identity.publicKey,
      controllerFingerprint: identity.fingerprint,
      nonce,
      expiresAt,
    };
    const signature = await signMeshPayload(
      buildMeshWorkerKillRequestSigningPayload(envelope),
    );
    const route = resolveMeshRoute(
      registration.workerEndpoint,
      "api/mesh/internal/kill",
    );
    await postMeshControlMessage(route, {
      ...envelope,
      signature,
    }, nonce, {
      headers: {
        "x-clanky-mesh-node-id": identity.nodeId,
      },
      tls: getMeshWorkerTlsOptions(registration),
    });
  }

  async removeRevokedWorker(
    userId: string,
    workerNodeId: string,
  ): Promise<void> {
    const registration = await getWorkerRegistration(workerNodeId, userId);
    if (registration?.registrationScope === "workspace") {
      throw new DomainError(
        "workspace_worker_workspace_scoped",
        "Workspace-dedicated workers are removed with their workspace.",
      );
    }

    await deleteRevokedWorkerRegistration(workerNodeId, userId);
    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged: true },
      { userId },
    );
  }

  async removeDedicatedWorker(
    userId: string,
    workerNodeId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const registration = await getWorkerRegistration(workerNodeId, userId);
    if (!registration) {
      return;
    }
    if (registration.registrationScope !== "workspace") {
      throw new DomainError(
        "mesh_worker_not_found",
        "The dedicated worker registration was not found.",
      );
    }
    if (registration.grantStatus !== "revoked") {
      throw new DomainError(
        "mesh_peer_revoked",
        "The dedicated worker must be revoked before it is removed.",
      );
    }
    await deleteRevokedWorkerRegistration(workerNodeId, userId);
    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged: true },
      { userId },
    );
  }

  async revokeDedicatedWorker(
    userId: string,
    enrollmentOrWorkspaceId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const registration = await getWorkerRegistrationByEnrollment(
      enrollmentOrWorkspaceId,
      userId,
    ) ?? await getWorkerRegistrationByWorkspace(enrollmentOrWorkspaceId, userId);
    if (!registration) {
      throw new DomainError(
        "mesh_worker_not_found",
        "The dedicated worker registration was not found.",
      );
    }
    if (registration.registrationScope !== "workspace") {
      throw new DomainError(
        "workspace_worker_workspace_scoped",
        "The selected worker is not workspace-dedicated.",
      );
    }

    const identity = await ensureLocalMeshNodeIdentity();
    const envelope: Omit<MeshRevocationNotice, "signature"> = {
      protocolVersion: 1,
      controllerNodeId: identity.nodeId,
      workerNodeId: registration.workerNodeId,
      controllerPublicKey: identity.publicKey,
      controllerFingerprint: identity.fingerprint,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    try {
      const signature = await signMeshPayload(
        buildMeshRevocationNoticeSigningPayload(envelope),
      );
      const route = resolveMeshRoute(
        registration.workerEndpoint,
        "api/mesh/internal/revocation",
      );
      await postMeshControlMessage(route, {
        ...envelope,
        signature,
      }, identity.nodeId, {
        headers: {
          "x-clanky-mesh-node-id": identity.nodeId,
        },
        tls: getMeshWorkerTlsOptions(registration),
      });
    } catch (error) {
      log.warn("Dedicated worker remote revocation could not be delivered", {
        workerNodeId: registration.workerNodeId,
        error: String(error),
      });
    } finally {
      await revokeWorkerRegistration(registration.workerNodeId, userId);
      if (registration.workspaceWorkerEnrollmentId) {
        workspaceWorkerEnrollmentService.markFailed(
          userId,
          registration.workspaceWorkerEnrollmentId,
          "workspace_deleted",
          "The workspace-dedicated worker was detached.",
          "cancelled",
          true,
        );
      }
      meshStateEventEmitter.emit(
        { type: "mesh.changed", executionHostsChanged: true },
        { userId },
      );
    }
  }

  async cleanupDedicatedWorker(
    userId: string,
    enrollmentId: string,
    options: { preserveRegistration?: boolean } = {},
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    let status = workspaceWorkerEnrollmentService.getStatus(userId, enrollmentId);
    const workerNodeId = status.enrollment.workerNodeId;
    if (!workerNodeId) {
      workspaceWorkerEnrollmentService.markFailed(
        userId,
        enrollmentId,
        "enrollment_cancelled",
        "The workspace-dedicated worker was detached.",
        "cancelled",
        true,
      );
      return;
    }

    if (!status.worker) {
      const host = getExecutionHostByRef(userId, {
        kind: "mesh",
        scope: status.enrollment.workspaceId ? "workspace" : "enrollment",
        ...(status.enrollment.workspaceId
          ? { workspaceId: status.enrollment.workspaceId }
          : { enrollmentId }),
        nodeId: workerNodeId,
      });
      if (host) {
        deleteExecutionHost(userId, host.id);
      }
      workspaceWorkerEnrollmentService.markFailed(
        userId,
        enrollmentId,
        "worker_registration_missing",
        "The workspace-dedicated worker registration was already removed.",
        "cancelled",
        true,
      );
      return;
    }

    if (status.worker?.grantStatus === "active") {
      await this.revokeDedicatedWorker(userId, enrollmentId);
      status = workspaceWorkerEnrollmentService.getStatus(userId, enrollmentId);
    }
    if (status.worker?.grantStatus === "revoked" && options.preserveRegistration !== true) {
      await this.removeDedicatedWorker(userId, workerNodeId);
    }
  }

  // --- Controller: health check ---

  async checkWorkerHealth(
    userId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const workers = await listActiveWorkerRegistrations(userId);

    let executionHostsChanged = false;
    for (const worker of workers) {
      try {
        const nonce = crypto.randomUUID();
        const sentAt = new Date().toISOString();
        const envelope: Omit<MeshHealthCheck, "signature"> = {
          protocolVersion: 1,
          senderNodeId: identity.nodeId,
          senderPublicKey: identity.publicKey,
          senderFingerprint: identity.fingerprint,
          nonce,
          sentAt,
        };
        const signature = await signMeshPayload(
          buildMeshHealthCheckSigningPayload(envelope),
        );
        const route = resolveMeshRoute(
          worker.workerEndpoint,
          "api/mesh/internal/health",
        );
        const response = await postMeshControlMessage(route, {
          ...envelope,
          signature,
        }, nonce, {
          tls: getMeshWorkerTlsOptions(worker),
        });
        const parsedResponse = MeshHealthCheckResponseSchema.safeParse(
          await response.json(),
        );
        if (!parsedResponse.success) {
          throw new DomainError(
            "mesh_health_check_response_invalid",
            "The worker health response has an invalid shape.",
          );
        }
        const health = parsedResponse.data;
        if (
          health.workerNodeId !== worker.workerNodeId
          || health.controllerNodeId !== identity.nodeId
          || health.requestNonce !== nonce
        ) {
          throw new DomainError(
            "mesh_health_check_response_invalid",
            "The worker health response does not match the request.",
          );
        }
        const { signature: responseSignature, ...unsignedResponse } = health;
        if (!await verifyMeshPayloadSignature(
          buildMeshHealthCheckResponseSigningPayload(unsignedResponse),
          responseSignature,
          worker.workerPublicKey,
        )) {
          throw new DomainError(
            "mesh_health_check_response_invalid",
            "The worker health response signature is invalid.",
          );
        }
        if (health.workerConfigRevision < worker.workerConfigRevision) {
          throw new DomainError(
            "mesh_health_check_response_invalid",
            "The worker health response contains a stale configuration revision.",
          );
        }
        const configurationChanged =
          health.workerConfigRevision !== worker.workerConfigRevision
          || health.workerDirectory !== worker.workerDirectory
          || health.workerAcceptRemoteExecution !== worker.workerAcceptRemoteExecution
          || JSON.stringify(health.workerCapabilities)
            !== JSON.stringify(worker.workerCapabilities);
        if (
          health.workerConfigRevision === worker.workerConfigRevision
          && configurationChanged
        ) {
          throw new DomainError(
            "mesh_health_check_response_invalid",
            "The worker changed configuration without advancing its revision.",
          );
        }
        await updateWorkerHealthSnapshot({
          workerNodeId: worker.workerNodeId,
          localUserId: userId,
          directory: health.workerDirectory,
          capabilities: health.workerCapabilities,
          acceptRemoteExecution: health.workerAcceptRemoteExecution,
          configRevision: health.workerConfigRevision,
        });
        executionHostsChanged ||= configurationChanged;
      } catch (error) {
        log.warn("Worker health check failed", {
          workerNodeId: worker.workerNodeId,
          error: String(error),
        });
        // No trust mutation — failed health does not change grant status
      }

    }

    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged },
      { userId },
    );
  }

  // --- Worker: receive health check ---

  async receiveHealthCheck(
    envelope: MeshHealthCheck,
  ): Promise<MeshHealthCheckResponse> {
    requireMeshRuntimeRole("worker");
    assertMeshPeerIdentity(
      envelope.senderPublicKey,
      envelope.senderFingerprint,
      "health check sender",
    );
    const signingPayload = buildMeshHealthCheckSigningPayload(envelope);
    const valid = await verifyMeshPayloadSignature(
      signingPayload,
      envelope.signature,
      envelope.senderPublicKey,
    );
    if (!valid) {
      throw new DomainError(
        "mesh_health_check_invalid_signature",
        "The health check signature is invalid.",
      );
    }
    // Verify the sender has an active grant
    const grant = await getControllerGrant(envelope.senderNodeId);
    if (!grant || grant.grantStatus !== "active") {
      throw new DomainError(
        "mesh_peer_not_trusted",
        "The health check sender does not have an active grant.",
      );
    }
    if (
      grant.controllerPublicKey !== envelope.senderPublicKey
      || grant.controllerFingerprint !== envelope.senderFingerprint
    ) {
      throw new DomainError(
        "mesh_peer_not_trusted",
        "The health check sender identity does not match the stored grant.",
      );
    }
    log.debug("Received valid health check", {
      senderNodeId: envelope.senderNodeId,
    });
    const identity = await ensureLocalMeshNodeIdentity();
    const execution = await getWorkerExecutionConfig();
    const response: Omit<MeshHealthCheckResponse, "signature"> = {
      protocolVersion: 1,
      workerNodeId: identity.nodeId,
      controllerNodeId: envelope.senderNodeId,
      requestNonce: envelope.nonce,
      workerDirectory: execution.directory,
      workerCapabilities: execution.capabilities,
      workerAcceptRemoteExecution: execution.acceptRemoteExecution,
      workerConfigRevision: execution.revision,
    };
    return {
      ...response,
      signature: await signMeshPayload(
        buildMeshHealthCheckResponseSigningPayload(response),
      ),
    };
  }

  // --- Worker: enrollment against a controller ---

  async enrollWithController(input: {
    controllerEndpoint: string;
    enrollmentToken: string;
    expectedFingerprint: string;
  }): Promise<MeshControllerGrant> {
    requireMeshRuntimeRole("worker");
    assertMeshEndpointAllowed(input.controllerEndpoint);
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const instanceName = requireMeshInstanceName(identity);

    if (!identity.meshEndpoint) {
      throw new DomainError(
        "mesh_endpoint_required",
        "This worker must have a configured mesh endpoint before enrollment.",
      );
    }

    const execution = await getWorkerExecutionConfig();
    const workerTlsIdentity = getMeshTransport(identity.meshEndpoint) === "https"
      ? await getMeshWorkerTlsIdentity()
      : null;
    if (getMeshTransport(identity.meshEndpoint) === "https" && !workerTlsIdentity) {
      throw new DomainError(
        "mesh_worker_tls_identity_missing",
        "The HTTPS worker TLS identity is missing from the data directory.",
      );
    }
    const nonce = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const envelope: Omit<MeshEnrollmentRequest, "signature"> = {
      protocolVersion: 1,
      workerNodeId: identity.nodeId,
      workerInstanceName: instanceName,
      workerEndpoint: identity.meshEndpoint,
      workerTransport: getMeshTransport(identity.meshEndpoint),
      workerPublicKey: identity.publicKey,
      workerFingerprint: identity.fingerprint,
      workerEncryptionPublicKey: identity.encryptionPublicKey,
      workerTlsCertificate: workerTlsIdentity?.certificate ?? null,
      workerTlsFingerprint: workerTlsIdentity?.fingerprint ?? null,
      workerDirectory: execution.directory,
      workerCapabilities: execution.capabilities,
      workerAcceptRemoteExecution: execution.acceptRemoteExecution,
      workerConfigRevision: execution.revision,
      enrollmentToken: input.enrollmentToken,
      expectedControllerFingerprint: input.expectedFingerprint,
      nonce,
      expiresAt,
    };
    const signature = await signMeshPayload(
      buildMeshEnrollmentRequestSigningPayload(envelope),
    );

    const route = resolveMeshRoute(
      input.controllerEndpoint,
      "api/mesh/internal/enrollment",
    );
    const response = await postMeshControlMessage(route, {
      ...envelope,
      signature,
    }, identity.nodeId);

    const body = await response.json() as MeshEnrollmentResponse;

    if (
      body.protocolVersion !== 1
      || body.workerNodeId !== identity.nodeId
      || body.controllerFingerprint !== input.expectedFingerprint
    ) {
      throw new DomainError(
        "mesh_enrollment_controller_mismatch",
        "The controller response fingerprint does not match the expected value.",
      );
    }
    assertMeshPeerIdentity(
      body.controllerPublicKey,
      body.controllerFingerprint,
      "enrollment controller",
    );
    const { signature: responseSignature, ...unsignedResponse } = body;
    if (!await verifyMeshPayloadSignature(
      buildMeshEnrollmentResponseSigningPayload(unsignedResponse),
      responseSignature,
      body.controllerPublicKey,
    )) {
      throw new DomainError(
        "mesh_enrollment_invalid_signature",
        "The controller enrollment response signature is invalid.",
      );
    }

    // Decide and store the grant
    const existingGrant = await getControllerGrant(body.controllerNodeId);
    const decision = decideAcceptEnrollment({
      existingGrant,
      controllerNodeId: body.controllerNodeId,
      localNodeId: identity.nodeId,
    });

    if (decision.kind === "apply") {
      return saveControllerGrant({
        controllerNodeId: body.controllerNodeId,
        controllerInstanceName: body.controllerInstanceName,
        controllerPublicKey: body.controllerPublicKey,
        controllerFingerprint: body.controllerFingerprint,
        controllerEncryptionPublicKey: body.controllerEncryptionPublicKey ?? null,
      });
    }

    // idempotent — return existing grant
    return existingGrant!;
  }

  // --- Worker: receive revocation notice ---

  async receiveRevocationNotice(
    envelope: MeshRevocationNotice,
  ): Promise<void> {
    requireMeshRuntimeRole("worker");
    assertMeshPeerIdentity(
      envelope.controllerPublicKey,
      envelope.controllerFingerprint,
      "revoking controller",
    );
    const signingPayload = buildMeshRevocationNoticeSigningPayload(envelope);
    const valid = await verifyMeshPayloadSignature(
      signingPayload,
      envelope.signature,
      envelope.controllerPublicKey,
    );
    if (!valid) {
      throw new DomainError(
        "mesh_revocation_invalid_signature",
        "The revocation notice signature is invalid.",
      );
    }
    if (Date.parse(envelope.expiresAt) <= Date.now()) {
      throw new DomainError(
        "mesh_revocation_expired",
        "The revocation notice has expired.",
      );
    }
    const identity = await ensureLocalMeshNodeIdentity();
    if (envelope.workerNodeId !== identity.nodeId) {
      throw new DomainError(
        "mesh_peer_target_invalid",
        "The revocation notice targets a different Mesh worker.",
      );
    }

    const grant = await getControllerGrant(envelope.controllerNodeId);
    if (!grant) {
      log.debug("Received revocation for unknown controller", {
        controllerNodeId: envelope.controllerNodeId,
      });
      return;
    }
    if (
      grant.controllerPublicKey !== envelope.controllerPublicKey
      || grant.controllerFingerprint !== envelope.controllerFingerprint
    ) {
      throw new DomainError(
        "mesh_peer_not_trusted",
        "The revocation notice identity does not match the stored grant.",
      );
    }

    if (grant.grantStatus === "active") {
      await revokeControllerGrant(envelope.controllerNodeId);
      log.info("Controller revoked this worker's grant", {
        controllerNodeId: envelope.controllerNodeId,
      });
    }
  }

  async receiveWorkerKillRequest(
    envelope: MeshWorkerKillRequest,
  ): Promise<void> {
    requireMeshRuntimeRole("worker");
    assertMeshPeerIdentity(
      envelope.controllerPublicKey,
      envelope.controllerFingerprint,
      "killing controller",
    );
    const signingPayload = buildMeshWorkerKillRequestSigningPayload(envelope);
    const valid = await verifyMeshPayloadSignature(
      signingPayload,
      envelope.signature,
      envelope.controllerPublicKey,
    );
    if (!valid) {
      throw new DomainError(
        "mesh_worker_kill_invalid_signature",
        "The worker kill signature is invalid.",
      );
    }
    const now = Date.now();
    const expiresAt = Date.parse(envelope.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new DomainError(
        "mesh_worker_kill_expired",
        "The worker kill request has expired.",
      );
    }
    if (expiresAt > now + MESH_WORKER_KILL_REQUEST_TTL_MS) {
      throw new DomainError(
        "mesh_worker_kill_expiry_invalid",
        "The worker kill request expiry is too far in the future.",
      );
    }
    const identity = await ensureLocalMeshNodeIdentity();
    if (envelope.workerNodeId !== identity.nodeId) {
      throw new DomainError(
        "mesh_peer_target_invalid",
        "The worker kill request targets a different Mesh worker.",
      );
    }

    const grant = await getControllerGrant(envelope.controllerNodeId);
    if (!grant || grant.grantStatus !== "active") {
      throw new DomainError(
        "mesh_peer_not_trusted",
        "The worker kill sender does not have an active grant.",
      );
    }
    if (
      grant.controllerPublicKey !== envelope.controllerPublicKey
      || grant.controllerFingerprint !== envelope.controllerFingerprint
    ) {
      throw new DomainError(
        "mesh_peer_not_trusted",
        "The worker kill sender identity does not match the stored grant.",
      );
    }
    const nonceClaim = claimMeshWorkerKillNonce(
      envelope.nonce,
      new Date(expiresAt).toISOString(),
    );
    if (nonceClaim === "replay") {
      throw new DomainError(
        "mesh_worker_kill_replay",
        "The worker kill request has already been used.",
      );
    }
    if (nonceClaim === "capacity") {
      throw new DomainError(
        "mesh_worker_kill_capacity",
        "The worker kill request capacity has been reached.",
      );
    }

    log.info("Received worker kill command", {
      controllerNodeId: envelope.controllerNodeId,
    });
    setTimeout(
      () => process.exit(MESH_WORKER_KILL_EXIT_CODE),
      MESH_WORKER_KILL_DELAY_MS,
    );
  }

  // --- Worker: get status ---

  async getWorkerStatus(): Promise<MeshWorkerStatus> {
    requireMeshRuntimeRole("worker");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const controllers = (await listControllerGrants()).filter(
      (grant) => grant.grantStatus === "active",
    );
    const execution = await getWorkerExecutionConfig();
    return { node: identity, execution, controllerCount: controllers.length };
  }

  async getStatus(userId: string): Promise<MeshControllerStatus | MeshWorkerStatus> {
    return getMeshRuntimeRole() === "worker"
      ? await this.getWorkerStatus()
      : await this.getControllerStatus(userId);
  }

  // --- Shared: identity management ---

  async setInstanceName(
    instanceName: string,
  ): Promise<MeshNodeIdentity> {
    const identity = await setLocalMeshInstanceName(instanceName);
    meshStateEventEmitter.emit({ type: "mesh.changed", executionHostsChanged: true });
    return identity;
  }

  async setEndpoint(
    endpoint: string,
  ): Promise<MeshNodeIdentity> {
    assertMeshEndpointAllowed(endpoint);
    const identity = await setLocalMeshEndpoint(endpoint);
    meshStateEventEmitter.emit({ type: "mesh.changed", executionHostsChanged: true });
    return identity;
  }
}

/**
 * Get the worker's local execution configuration.
 * Worker directory is process.cwd() or CLANKY_WORKER_DIRECTORY.
 */
async function getWorkerExecutionConfig(): Promise<MeshWorkerExecutionConfig> {
  const identity = await ensureLocalMeshNodeIdentity();
  const directory = getMeshWorkerDirectory();
  return {
    directory,
    acceptRemoteExecution: isMeshWorkerExecutionEnabled(),
    capabilities: { ...DEFAULT_EXECUTION_HOST_CAPABILITIES },
    revision: identity.execution.revision,
  };
}

/**
 * Resolve the worker directory with flag > env > config > cwd precedence.
 */
export const meshManager = new MeshManager();
