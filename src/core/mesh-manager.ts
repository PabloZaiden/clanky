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
  MeshWorkerUpdateRequest,
} from "@/contracts/schemas/mesh";
import { MeshHealthCheckResponseSchema } from "@/contracts/schemas/mesh";
import type {
  MeshControllerGrant,
  MeshControllerStatus,
  MeshNodeIdentity,
  MeshWorkerExecutionConfig,
  MeshWorkerStatus,
  MeshWorkerUpdateStatus,
} from "@/shared/mesh";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "@/shared/execution-host";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  getControllerGrant,
  getWorkerRegistration,
  listActiveWorkerRegistrations,
  listControllerGrants,
  listWorkerRegistrations,
  revokeControllerGrant,
  revokeWorkerRegistration,
  deleteRevokedWorkerRegistration,
  saveControllerGrant,
  saveWorkerRegistration,
  updateWorkerHealthSnapshot,
} from "../persistence/mesh";
import {
  consumeMeshEnrollmentToken,
  createMeshEnrollmentToken,
  listMeshEnrollmentTokens,
} from "../persistence/mesh-enrollment-tokens";
import {
  ensureLocalMeshNodeIdentity,
  setLocalMeshEndpoint,
  setLocalMeshInstanceName,
  signMeshPayload,
  verifyMeshPayloadSignature,
} from "../persistence/mesh-node-identity";
import {
  buildMeshEnrollmentRequestSigningPayload,
  buildMeshEnrollmentResponseSigningPayload,
  buildMeshHealthCheckSigningPayload,
  buildMeshHealthCheckResponseSigningPayload,
  buildMeshRevocationNoticeSigningPayload,
  buildMeshWorkerUpdateSigningPayload,
} from "./mesh-protocol";
import {
  assertMeshEndpointAllowed,
  getMeshTransport,
  resolveAdvertisedMeshEndpoint,
  resolveMeshRoute,
} from "./mesh-transport-config";
import { DomainError } from "./domain-error";
import { postMeshControlMessage } from "./mesh-control-client";
import { assertMeshPeerIdentity } from "./mesh-peer-auth";
import {
  decideEnrollWorker,
  decideRevokeWorker,
  decideAcceptEnrollment,
} from "../domain/mesh-transitions";
import { meshStateEventEmitter } from "./event-emitter";
import {
  getMeshRuntimeRole,
  getMeshWorkerDirectory,
  isMeshWorkerExecutionEnabled,
  requireMeshRuntimeRole,
} from "./mesh-runtime";

const log = createLogger("core:mesh-manager");
const WORKER_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const WORKER_UPDATE_POLL_INTERVAL_MS = 500;

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
    return createMeshEnrollmentToken(userId, name, ttlSeconds, {
      nodeId: identity.nodeId,
      fingerprint: identity.fingerprint,
    });
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
    const decision = decideEnrollWorker({
      existingRegistration,
      workerNodeId: envelope.workerNodeId,
      localNodeId: identity.nodeId,
    });

    if (decision.kind === "apply") {
      await saveWorkerRegistration({
        workerNodeId: envelope.workerNodeId,
        localUserId: tokenResult.userId,
        workerInstanceName: envelope.workerInstanceName ?? null,
        workerEndpoint: envelope.workerEndpoint,
        workerTransport: envelope.workerTransport,
        workerPublicKey: envelope.workerPublicKey,
        workerFingerprint: envelope.workerFingerprint,
        workerEncryptionPublicKey: envelope.workerEncryptionPublicKey ?? null,
        workerDirectory: envelope.workerDirectory,
        workerCapabilities: envelope.workerCapabilities,
        workerAcceptRemoteExecution: envelope.workerAcceptRemoteExecution,
        workerConfigRevision: envelope.workerConfigRevision,
      });
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
      "x-clanky-mesh-node-id": identity.nodeId,
    });

    if (decision.kind === "apply") {
      await revokeWorkerRegistration(workerNodeId, userId);
    }

    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged: true },
      { userId },
    );
  }

  async removeRevokedWorker(
    userId: string,
    workerNodeId: string,
  ): Promise<void> {
    await deleteRevokedWorkerRegistration(workerNodeId, userId);
    meshStateEventEmitter.emit(
      { type: "mesh.changed", executionHostsChanged: true },
      { userId },
    );
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
        }, nonce);
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

  async updateWorker(
    userId: string,
    workerNodeId: string,
  ): Promise<MeshWorkerUpdateStatus> {
    requireMeshRuntimeRole("controller");
    const identity = await ensureLocalMeshIdentityWithEndpoint();
    const registration = await getWorkerRegistration(workerNodeId, userId);
    if (!registration || registration.grantStatus !== "active") {
      throw new DomainError("mesh_worker_not_found", "The active Mesh worker was not found.");
    }
    const operationId = crypto.randomUUID();
    const sendUpdateRequest = async (
      action: "start" | "status",
    ): Promise<MeshWorkerUpdateStatus> => {
      const nonce = crypto.randomUUID();
      const unsigned: Omit<MeshWorkerUpdateRequest, "signature"> = {
        protocolVersion: 1,
        action,
        operationId,
        controllerNodeId: identity.nodeId,
        workerNodeId: registration.workerNodeId,
        controllerPublicKey: identity.publicKey,
        controllerFingerprint: identity.fingerprint,
        nonce,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const response = await postMeshControlMessage(
        resolveMeshRoute(registration.workerEndpoint, "api/mesh/internal/update"),
        {
          ...unsigned,
          signature: await signMeshPayload(buildMeshWorkerUpdateSigningPayload(unsigned)),
        },
        nonce,
        {
          "x-clanky-mesh-node-id": identity.nodeId,
        },
      );
      return await response.json() as MeshWorkerUpdateStatus;
    };
    let update = await sendUpdateRequest("start");
    const deadline = Date.now() + WORKER_UPDATE_TIMEOUT_MS;
    while (update.state === "updating" || update.state === "handoff") {
      if (Date.now() >= deadline) {
        throw new DomainError(
          "mesh_worker_update_timeout",
          "Timed out waiting for the Mesh worker update to finish.",
        );
      }
      await Bun.sleep(WORKER_UPDATE_POLL_INTERVAL_MS);
      try {
        update = await sendUpdateRequest("status");
      } catch (error) {
        if (
          error instanceof DomainError
          && (
            error.code === "mesh_control_request_unreachable"
            || (
              error.code === "mesh_control_request_rejected"
              && typeof error.details["status"] === "number"
              && [502, 503, 504].includes(error.details["status"])
            )
          )
        ) {
          continue;
        }
        throw error;
      }
    }
    if (update.state === "failed") {
      throw new DomainError(
        "mesh_worker_update_failed",
        update.error ?? "The Mesh worker update failed.",
      );
    }
    return update;
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

    if (!identity.meshEndpoint) {
      throw new DomainError(
        "mesh_endpoint_required",
        "This worker must have a configured mesh endpoint before enrollment.",
      );
    }

    const execution = await getWorkerExecutionConfig();
    const nonce = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const envelope: Omit<MeshEnrollmentRequest, "signature"> = {
      protocolVersion: 1,
      workerNodeId: identity.nodeId,
      workerInstanceName: identity.instanceName,
      workerEndpoint: identity.meshEndpoint,
      workerTransport: getMeshTransport(identity.meshEndpoint),
      workerPublicKey: identity.publicKey,
      workerFingerprint: identity.fingerprint,
      workerEncryptionPublicKey: identity.encryptionPublicKey,
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
