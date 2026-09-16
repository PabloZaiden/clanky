/**
 * Core orchestration for the controller-worker mesh.
 *
 * Controllers enroll workers via single-use tokens. Workers store independent
 * grants. No membership gossip, no roster propagation, no peer-to-peer
 * relationships.
 */

import type {
  MeshEnrollmentRoute,
  MeshEnrollmentRequest,
  MeshEnrollmentRequestV1,
  MeshEnrollmentRequestV2,
  MeshEnrollmentResponse,
  MeshHealthCheck,
  MeshHealthCheckResponse,
  MeshRevocationNotice,
  MeshWorkerKillRequest,
} from "@/contracts/schemas/mesh";
import {
  MeshEnrollmentResponseSchema,
  MeshHealthCheckResponseSchema,
} from "@/contracts/schemas/mesh";
import type {
  MeshControllerGrant,
  MeshControllerStatus,
  MeshNodeIdentity,
  MeshPeerRoute,
  MeshWorkerExecutionConfig,
  MeshWorkerRegistration,
  MeshWorkerStatus,
} from "@/shared/mesh";
import {
  MESH_RUNTIME_SNAPSHOT_HEADER,
  MESH_RUNTIME_SNAPSHOT_VERSION,
  MESH_WORKER_KILL_REQUEST_TTL_MS,
} from "@/shared/mesh";
import {
  createExecutionHostRuntimeSnapshot,
  type ExecutionHostCapabilities,
} from "@/shared/execution-host";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  InconsistentMeshControllerRelayGrantError,
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
import { InvalidMeshRelayRouteError } from "../persistence/errors";
import {
  assertActiveControllerWorkerIdentity,
  InconsistentMeshWorkerIdentityError,
} from "../persistence/controller-relay-pairing";
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
} from "./mesh-transport-config";
import { DomainError, isDomainError } from "./domain-error";
import {
  postMeshControlMessage,
  readMeshControlResponseJson,
} from "./mesh-control-client";
import { assertMeshPeerIdentity } from "./mesh-peer-auth";
import { meshExecutionGateway } from "./mesh-execution-gateway";
import {
  decideEnrollWorker,
  decideRevokeWorker,
  decideAcceptEnrollment,
} from "../domain/mesh-transitions";
import { buildWorkerJoinCommand } from "./mesh-join-command";
import { controllerRelayService } from "./controller-relay-service";
import {
  createMeshRelayEnrollmentAdmission,
  isMeshRelayEnrollmentAdmissionToken,
} from "./mesh-relay-admission";
import { discoverMeshEnrollmentTarget } from "./mesh-target-discovery";
import { MeshRelayConnector } from "./mesh-relay-connector";
import { createMeshRelayPeerTransport } from "./mesh-relay-transport";
import { getMeshRelayFingerprint } from "./mesh-relay-identity";
import { workerRelayService } from "./worker-relay-service";
import { meshStateEventEmitter } from "./event-emitter";
import {
  getMeshRuntimeRole,
  getMeshWorkerDirectory,
  isMeshWorkerRelayOnly,
  isMeshWorkerExecutionEnabled,
  requireMeshRuntimeRole,
} from "./mesh-runtime";

const LEGACY_MESH_EXECUTION_CAPABILITY_IDS = [
  "commandExecution",
  "fileOperations",
  "acpRuntime",
  "interactiveTerminal",
  "provisioning",
  "devboxLifecycle",
  "tcpTunnel",
  "serverHealth",
] as const;

function capabilitiesForMeshPeer(
  capabilities: ExecutionHostCapabilities,
  supportsRuntimeSnapshot: boolean,
): ExecutionHostCapabilities {
  if (supportsRuntimeSnapshot) {
    return capabilities;
  }
  const compatible: ExecutionHostCapabilities = {};
  for (const capability of LEGACY_MESH_EXECUTION_CAPABILITY_IDS) {
    const version = capabilities[capability];
    if (version !== undefined) {
      compatible[capability] = version;
    }
  }
  return compatible;
}

const log = createLogger("core:mesh-manager");
const MESH_WORKER_KILL_DELAY_MS = 100;
const MESH_WORKER_KILL_EXIT_CODE = 1;

function meshRoutesEqual(
  left: MeshPeerRoute | null | undefined,
  right: MeshPeerRoute,
): boolean {
  if (!left || left.kind !== right.kind) {
    return false;
  }
  return left.kind === "direct" && right.kind === "direct"
    ? left.endpoint === right.endpoint
      && left.transport === right.transport
      && left.tlsTrust === right.tlsTrust
      && left.tlsCertificate === right.tlsCertificate
      && left.tlsFingerprint === right.tlsFingerprint
    : left.kind === "relay" && right.kind === "relay"
      && left.targetNodeId === right.targetNodeId
      && left.relayUrl === right.relayUrl
      && left.relayFingerprint === right.relayFingerprint;
}

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
    route: MeshEnrollmentRoute = "direct",
  ) {
    requireMeshRuntimeRole("controller");
    const identity = route === "direct"
      ? await ensureLocalMeshIdentityWithEndpoint()
      : await ensureLocalMeshNodeIdentity();
    const invitation = await controllerRelayService.resolveEnrollmentInvitationTarget(
      route,
      route === "direct"
        ? identity.meshEndpoint ?? resolveAdvertisedMeshEndpoint()
        : "",
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    const admission = route === "relay"
      ? await createMeshRelayEnrollmentAdmission({
          controllerNodeId: identity.nodeId,
          controllerFingerprint: identity.fingerprint,
          expiresAt,
        })
      : undefined;
    const created = createMeshEnrollmentToken(
      userId,
      name,
      ttlSeconds,
      {
        nodeId: identity.nodeId,
        fingerprint: identity.fingerprint,
      },
      {
        ...(admission ? { token: admission, expiresAt } : {}),
      },
    );
    return {
      ...created,
      workerJoinCommand: buildWorkerJoinCommand({
        target: invitation.target,
        enrollmentToken: created.token,
        controllerFingerprint: identity.fingerprint,
      }),
    };
  }

  async createWorkspaceWorkerEnrollment(
    userId: string,
    name: string,
    ttlSeconds: number,
    route: MeshEnrollmentRoute = "direct",
  ) {
    requireMeshRuntimeRole("controller");
    const identity = route === "direct"
      ? await ensureLocalMeshIdentityWithEndpoint()
      : await ensureLocalMeshNodeIdentity();
    const invitation = await controllerRelayService.resolveEnrollmentInvitationTarget(
      route,
      route === "direct"
        ? identity.meshEndpoint ?? resolveAdvertisedMeshEndpoint()
        : "",
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    const admission = route === "relay"
      ? await createMeshRelayEnrollmentAdmission({
          controllerNodeId: identity.nodeId,
          controllerFingerprint: identity.fingerprint,
          expiresAt,
        })
      : undefined;
    const created = workspaceWorkerEnrollmentService.create(userId, {
      name,
      ttlSeconds,
      controller: {
        nodeId: identity.nodeId,
        fingerprint: identity.fingerprint,
      },
      ...(admission ? { token: admission, expiresAt } : {}),
    });
    return {
      ...created,
      workerJoinCommand: buildWorkerJoinCommand({
        target: invitation.target,
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
    if (envelope.protocolVersion === 1) {
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
    } else {
      const pairing = controllerRelayService.assertEnrollmentRelayRoute(
        envelope.route,
      );
      if (
        pairing.controllerNodeId !== identity.nodeId
        || pairing.controllerFingerprint !== identity.fingerprint
      ) {
        throw new DomainError(
          "mesh_relay_controller_identity_changed",
          "The persisted relay pairing belongs to a different controller identity.",
        );
      }
    }

    if (
      isMeshRelayEnrollmentAdmissionToken(envelope.enrollmentToken)
      !== (envelope.protocolVersion === 2)
    ) {
      throw new DomainError(
        "mesh_enrollment_relay_mismatch",
        "The enrollment token is not valid for the requested direct or relay route.",
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
    try {
      assertActiveControllerWorkerIdentity({
        nodeId: envelope.workerNodeId,
        publicKey: envelope.workerPublicKey,
        fingerprint: envelope.workerFingerprint,
      });
    } catch (error) {
      if (error instanceof InconsistentMeshWorkerIdentityError) {
        throw new DomainError(
          "mesh_worker_identity_conflict",
          "The worker identity conflicts with an active registration.",
          { cause: error, details: { nodeId: envelope.workerNodeId } },
        );
      }
      throw error;
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

    const enrollmentRoute: MeshPeerRoute = envelope.protocolVersion === 1
      ? {
          kind: "direct",
          endpoint: envelope.workerEndpoint,
          transport: envelope.workerTransport,
          tlsTrust: envelope.workerTransport === "https" ? "pinned" : "none",
          tlsCertificate: envelope.workerTlsCertificate,
          tlsFingerprint: envelope.workerTlsFingerprint,
        }
      : {
          kind: "relay",
          targetNodeId: envelope.workerNodeId,
          relayUrl: envelope.route.relayUrl,
          relayFingerprint: envelope.route.relayFingerprint,
        };
    if (
      decision.kind === "apply"
      || !meshRoutesEqual(existingRegistration?.route, enrollmentRoute)
    ) {
      const workspaceWorkerEnrollmentId = tokenResult.purpose === "workspace-worker"
        ? tokenResult.workspaceWorkerEnrollmentId!
        : undefined;
      try {
        await saveWorkerRegistration({
          workerNodeId: envelope.workerNodeId,
          localUserId: tokenResult.userId,
          workerInstanceName: envelope.workerInstanceName ?? null,
          workerEndpoint: envelope.protocolVersion === 1
            ? envelope.workerEndpoint
            : envelope.route.relayUrl,
          workerTransport: envelope.protocolVersion === 1
            ? envelope.workerTransport
            : getMeshTransport(envelope.route.relayUrl),
          workerPublicKey: envelope.workerPublicKey,
          workerFingerprint: envelope.workerFingerprint,
          workerEncryptionPublicKey: envelope.workerEncryptionPublicKey ?? null,
          workerTlsCertificate: envelope.protocolVersion === 1
            ? envelope.workerTlsCertificate
            : null,
          workerTlsFingerprint: envelope.protocolVersion === 1
            ? envelope.workerTlsFingerprint
            : null,
          route: enrollmentRoute,
          workerDirectory: envelope.workerDirectory,
          workerPlatform: envelope.workerPlatform ?? null,
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

    const response = {
      protocolVersion: envelope.protocolVersion,
      workerNodeId: envelope.workerNodeId,
      controllerNodeId: identity.nodeId,
      controllerInstanceName: identity.instanceName,
      controllerPublicKey: identity.publicKey,
      controllerFingerprint: identity.fingerprint,
      controllerEncryptionPublicKey: identity.encryptionPublicKey,
    } satisfies Omit<MeshEnrollmentResponse, "signature">;
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
    let registration: MeshWorkerRegistration | null;
    try {
      registration = await getWorkerRegistration(workerNodeId, userId);
    } catch (error) {
      if (!(error instanceof InvalidMeshRelayRouteError)) {
        throw error;
      }
      log.warn("Revoking worker with an invalid persisted relay route locally", {
        workerNodeId,
      });
      await revokeWorkerRegistration(workerNodeId, userId);
      meshStateEventEmitter.emit({ type: "mesh.changed", executionHostsChanged: true });
      return;
    }
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
      await postMeshControlMessage(target.route, "api/mesh/internal/revocation", {
        ...envelope,
        signature,
      }, identity.nodeId, {
        headers: {
          "x-clanky-mesh-node-id": identity.nodeId,
        },
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
    await postMeshControlMessage(registration.route, "api/mesh/internal/kill", {
      ...envelope,
      signature,
    }, nonce, {
      headers: {
        "x-clanky-mesh-node-id": identity.nodeId,
      },
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

  async updateWorkspaceWorkerEndpoint(
    userId: string,
    enrollmentId: string,
    workerEndpoint: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    workspaceWorkerEnrollmentService.updateWorkerEndpoint(
      userId,
      enrollmentId,
      workerEndpoint,
    );
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
      await postMeshControlMessage(registration.route, "api/mesh/internal/revocation", {
        ...envelope,
        signature,
      }, identity.nodeId, {
        headers: {
          "x-clanky-mesh-node-id": identity.nodeId,
        },
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

  private async probeWorkerHealth(
    options: {
      userId: string;
      identity: MeshNodeIdentity;
      worker: MeshWorkerRegistration;
      signal?: AbortSignal;
    },
  ): Promise<boolean> {
    const { identity, worker } = options;
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
    const response = await postMeshControlMessage(worker.route, "api/mesh/internal/health", {
      ...envelope,
      signature,
    }, nonce, {
      signal: options.signal,
      headers: {
        [MESH_RUNTIME_SNAPSHOT_HEADER]: String(
          MESH_RUNTIME_SNAPSHOT_VERSION,
        ),
      },
    });
    const parsedResponse = MeshHealthCheckResponseSchema.safeParse(
      await readMeshControlResponseJson(response, { signal: options.signal }),
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
      || health.workerAcceptRemoteExecution !== worker.workerAcceptRemoteExecution;
    if (
      health.workerConfigRevision === worker.workerConfigRevision
      && configurationChanged
    ) {
      throw new DomainError(
        "mesh_health_check_response_invalid",
        "The worker changed configuration without advancing its revision.",
      );
    }
    const runtimeSnapshotChanged =
      JSON.stringify(health.workerPlatform ?? null)
        !== JSON.stringify(worker.workerPlatform)
      || JSON.stringify(health.workerCapabilities)
        !== JSON.stringify(worker.workerCapabilities);
    await updateWorkerHealthSnapshot({
      workerNodeId: worker.workerNodeId,
      localUserId: options.userId,
      directory: health.workerDirectory,
      platform: health.workerPlatform ?? null,
      capabilities: health.workerCapabilities,
      acceptRemoteExecution: health.workerAcceptRemoteExecution,
      configRevision: health.workerConfigRevision,
    });
    return configurationChanged || runtimeSnapshotChanged;
  }

  async checkWorkerReachability(
    userId: string,
    workerNodeId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const worker = await getWorkerRegistration(workerNodeId, userId);
    if (!worker || worker.grantStatus !== "active") {
      throw new DomainError(
        "mesh_worker_not_found",
        "The selected Mesh worker is not active.",
      );
    }
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const executionHostsChanged = await this.probeWorkerHealth({
      userId,
      identity,
      worker,
      signal: options.signal,
    });
    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged },
      { userId },
    );
  }

  async checkWorkerHealth(
    userId: string,
  ): Promise<void> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const workers = await listActiveWorkerRegistrations(userId);

    let executionHostsChanged = false;
    for (const worker of workers) {
      try {
        executionHostsChanged ||= await this.probeWorkerHealth({
          userId,
          identity,
          worker,
        });
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
    options: { includeRuntimeSnapshot?: boolean } = {},
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
      ...(options.includeRuntimeSnapshot
        ? { workerPlatform: execution.platform }
        : {}),
      workerCapabilities: capabilitiesForMeshPeer(
        execution.capabilities,
        options.includeRuntimeSnapshot === true,
      ),
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
    target: string;
    enrollmentToken: string;
    expectedFingerprint: string;
  }): Promise<MeshControllerGrant> {
    requireMeshRuntimeRole("worker");
    const discovered = await discoverMeshEnrollmentTarget(input.target);
    const identity = discovered.descriptor.role === "controller"
      ? await ensureLocalMeshIdentityWithEndpoint()
      : await ensureLocalMeshNodeIdentity();
    const instanceName = requireMeshInstanceName(identity);
    const execution = await getWorkerExecutionConfig();
    const targetSupportsRuntimeSnapshot =
      discovered.descriptor.role === "controller"
      && discovered.runtimeSnapshotVersion >= MESH_RUNTIME_SNAPSHOT_VERSION;
    const nonce = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const common = {
      workerNodeId: identity.nodeId,
      workerInstanceName: instanceName,
      workerPublicKey: identity.publicKey,
      workerFingerprint: identity.fingerprint,
      workerEncryptionPublicKey: identity.encryptionPublicKey,
      workerDirectory: execution.directory,
      ...(targetSupportsRuntimeSnapshot
        ? { workerPlatform: execution.platform }
        : {}),
      workerCapabilities: capabilitiesForMeshPeer(
        execution.capabilities,
        targetSupportsRuntimeSnapshot,
      ),
      workerAcceptRemoteExecution: execution.acceptRemoteExecution,
      workerConfigRevision: execution.revision,
      enrollmentToken: input.enrollmentToken,
      expectedControllerFingerprint: input.expectedFingerprint,
      nonce,
      expiresAt,
    };
    let controllerRoute;
    let unsignedEnvelope:
      | Omit<MeshEnrollmentRequestV1, "signature">
      | Omit<MeshEnrollmentRequestV2, "signature">;
    let rawResponse: unknown;

    if (discovered.descriptor.role === "controller") {
      if (isMeshWorkerRelayOnly()) {
        throw new DomainError(
          "mesh_relay_only_direct_enrollment_forbidden",
          "A relay-only Mesh worker cannot enroll through a direct controller route.",
        );
      }
      if (discovered.descriptor.fingerprint !== input.expectedFingerprint) {
        throw new DomainError(
          "mesh_enrollment_controller_mismatch",
          "The discovered controller fingerprint does not match the expected value.",
        );
      }
      assertMeshPeerIdentity(
        discovered.descriptor.publicKey,
        discovered.descriptor.fingerprint,
        "discovered controller",
      );
      if (!identity.meshEndpoint) {
        throw new DomainError(
          "mesh_endpoint_required",
          "This worker must have a configured mesh endpoint before direct enrollment.",
        );
      }
      assertMeshEndpointAllowed(discovered.target);
      const workerTransport = getMeshTransport(identity.meshEndpoint);
      const workerTlsIdentity = workerTransport === "https"
        ? await getMeshWorkerTlsIdentity()
        : null;
      if (workerTransport === "https" && !workerTlsIdentity) {
        throw new DomainError(
          "mesh_worker_tls_identity_missing",
          "The HTTPS worker TLS identity is missing from the data directory.",
        );
      }
      unsignedEnvelope = {
        protocolVersion: 1,
        ...common,
        workerEndpoint: identity.meshEndpoint,
        workerTransport,
        workerTlsCertificate: workerTlsIdentity?.certificate ?? null,
        workerTlsFingerprint: workerTlsIdentity?.fingerprint ?? null,
      };
      const envelope = {
        ...unsignedEnvelope,
        signature: await signMeshPayload(
          buildMeshEnrollmentRequestSigningPayload(unsignedEnvelope),
        ),
      } as MeshEnrollmentRequest;
      controllerRoute = {
        kind: "direct" as const,
        endpoint: discovered.target,
        transport: getMeshTransport(discovered.target),
        tlsTrust: getMeshTransport(discovered.target) === "https"
          ? "system" as const
          : "none" as const,
        tlsCertificate: null,
        tlsFingerprint: null,
      };
      const response = await postMeshControlMessage(
        controllerRoute,
        "api/mesh/internal/enrollment",
        envelope,
        identity.nodeId,
      );
      rawResponse = await readMeshControlResponseJson<unknown>(response);
    } else {
      if (
        discovered.descriptor.controllerFingerprint
          !== input.expectedFingerprint
      ) {
        throw new DomainError(
          "mesh_enrollment_controller_mismatch",
          "The relay's controller fingerprint does not match the expected value.",
        );
      }
      if (!discovered.descriptor.controllerNodeId) {
        throw new DomainError(
          "mesh_enrollment_relay_unpaired",
          "The relay is not paired with a controller.",
        );
      }
      let relayFingerprint: string;
      try {
        relayFingerprint = getMeshRelayFingerprint(
          discovered.descriptor.publicKey,
        );
      } catch (error) {
        throw new DomainError(
          "mesh_enrollment_relay_identity_invalid",
          "The relay descriptor contains an invalid public identity.",
          { cause: error },
        );
      }
      if (relayFingerprint !== discovered.descriptor.fingerprint) {
        throw new DomainError(
          "mesh_enrollment_relay_identity_invalid",
          "The relay public key does not match its advertised fingerprint.",
        );
      }
      controllerRoute = {
        kind: "relay" as const,
        targetNodeId: discovered.descriptor.controllerNodeId,
        relayUrl: discovered.target,
        relayFingerprint: discovered.descriptor.fingerprint,
      };
      await workerRelayService.assertRouteCompatible(
        discovered.descriptor.controllerNodeId,
        controllerRoute,
      );
      unsignedEnvelope = {
        protocolVersion: 2,
        ...common,
        route: {
          kind: "relay" as const,
          relayUrl: discovered.target,
          relayFingerprint: discovered.descriptor.fingerprint,
        },
      };
      const envelope = {
        ...unsignedEnvelope,
        signature: await signMeshPayload(
          buildMeshEnrollmentRequestSigningPayload(unsignedEnvelope),
        ),
      } as MeshEnrollmentRequest;
      const connector = new MeshRelayConnector({
        config: {
          relayUrl: discovered.target,
          relayFingerprint: discovered.descriptor.fingerprint,
          role: "worker",
          targetNodeId: discovered.descriptor.controllerNodeId,
          enrollmentAdmission: input.enrollmentToken,
        },
      });
      try {
        await connector.connect();
        const transport = createMeshRelayPeerTransport(() => connector);
        const response = await postMeshControlMessage(
          controllerRoute,
          "api/mesh/internal/enrollment",
          envelope,
          identity.nodeId,
          { transport },
        );
        rawResponse = await readMeshControlResponseJson<unknown>(response);
      } finally {
        connector.close(1000, "Worker relay enrollment complete");
      }
    }

    const parsedResponse = MeshEnrollmentResponseSchema.safeParse(
      rawResponse,
    );
    if (!parsedResponse.success) {
      throw new DomainError(
        "mesh_enrollment_response_invalid",
        "The controller enrollment response is incompatible or invalid.",
        { cause: parsedResponse.error },
      );
    }
    const body = parsedResponse.data;

    if (
      body.protocolVersion !== unsignedEnvelope.protocolVersion
      || body.workerNodeId !== identity.nodeId
      || body.controllerFingerprint !== input.expectedFingerprint
      || (
        controllerRoute.kind === "relay"
        && body.controllerNodeId !== controllerRoute.targetNodeId
      )
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

    if (controllerRoute.kind === "relay") {
      await workerRelayService.assertRouteCompatible(
        body.controllerNodeId,
        controllerRoute,
      );
    }
    if (
      decision.kind === "apply"
      || !meshRoutesEqual(existingGrant?.controllerRoute, controllerRoute)
    ) {
      let grant: MeshControllerGrant;
      try {
        grant = await saveControllerGrant({
          controllerNodeId: body.controllerNodeId,
          controllerInstanceName: body.controllerInstanceName,
          controllerPublicKey: body.controllerPublicKey,
          controllerFingerprint: body.controllerFingerprint,
          controllerEncryptionPublicKey: body.controllerEncryptionPublicKey ?? null,
          controllerRoute,
        });
      } catch (error) {
        if (error instanceof InconsistentMeshControllerRelayGrantError) {
          throw new DomainError(
            "mesh_worker_relay_grants_inconsistent",
            error.message,
            { cause: error },
          );
        }
        throw error;
      }
      await workerRelayService.refresh();
      return grant;
    }

    // idempotent — return existing grant
    await workerRelayService.refresh();
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
      meshExecutionGateway.abortAsyncCommandsForCaller(envelope.controllerNodeId);
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
  const runtimeSnapshot = createExecutionHostRuntimeSnapshot(
    process.platform,
    process.arch,
  );
  return {
    directory,
    acceptRemoteExecution: isMeshWorkerExecutionEnabled(),
    ...runtimeSnapshot,
    revision: identity.execution.revision,
  };
}

/**
 * Resolve the worker directory with flag > env > config > cwd precedence.
 */
export const meshManager = new MeshManager();
