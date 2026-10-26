/**
 * Dedicated outbound Mesh client connection, independent of worker transports.
 */
import type { WorkspaceClientRequestMetadata } from "@/contracts/schemas/mesh-client";
import {
  MESH_RELAY_CLIENT_ENROLLMENT_PATH,
  MESH_RELAY_CLIENT_OPERATION_PATH,
  MESH_RELAY_CLIENT_SOCKET_PATH,
  MESH_RELAY_WORKSPACE_CLIENT_VERSION,
  normalizeMeshRelayOrigin,
} from "@/shared/mesh-relay";
import { DomainError } from "../domain/domain-error";
import { MeshRelayConnectorManager } from "../client-sdk/collaboration/relay-manager";
import type { CollaborationClientLogger } from "../client-sdk/collaboration/types";
import type { MeshRelayConnectorIdentity, MeshRelayConnectorStatus } from "./mesh-relay-connector";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";
import { performMeshRelayHttpRequest } from "./mesh-relay-http-client";
import { MESH_RELAY_RESPONSE_FLOW_HEADER } from "./mesh-relay-http-response-flow";
import { createWorkspaceClientProof, readWorkspaceClientProof } from "../client-sdk/collaboration/proof";
import { discoverMeshEnrollmentTarget } from "./mesh-target-discovery";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import type { CollaborationRoute } from "@/shared/collaboration";
import { openWorkspaceDirectStream } from "../client-sdk/collaboration/direct-stream";

export type MeshWorkspaceClientOptions = CollaborationRoute & {
  identity: MeshRelayConnectorIdentity;
  controllerNodeId: string;
  controllerFingerprint: string;
  controllerPublicKey: string;
  enrollmentAdmission?: string;
  logger?: CollaborationClientLogger;
  onStatusChange?(status: MeshRelayConnectorStatus): void;
}

export class MeshWorkspaceClient {
  private readonly manager: MeshRelayConnectorManager;
  private readonly streams = new Set<MeshRelayDataStream>();
  private readonly opening = new Set<Promise<MeshRelayDataStream>>();
  private started = false;
  private stopping?: Promise<void>;
  private lifetime = new AbortController();
  private cleanupFailure?: unknown;
  private directStatus: MeshRelayConnectorStatus = "idle";

  constructor(private readonly options: MeshWorkspaceClientOptions) {
    this.manager = new MeshRelayConnectorManager({
      identity: options.identity,
      logger: options.logger,
    });
  }

  get status(): MeshRelayConnectorStatus {
    return this.options.controllerUrl !== undefined ? this.directStatus : this.manager.status;
  }

  private setDirectStatus(status: MeshRelayConnectorStatus): void {
    if (this.directStatus === status) return;
    this.directStatus = status;
    this.options.onStatusChange?.(status);
  }

  async start(options: { waitForConnection?: boolean } = {}): Promise<void> {
    if (this.started || this.stopping) {
      throw new DomainError("collaboration_connection_busy", "The workspace connection is already running.");
    }
    if (this.options.controllerUrl !== undefined) {
      this.lifetime = new AbortController();
      this.started = true;
      this.setDirectStatus("connecting");
      if (options.waitForConnection === false) return;
      try {
        const headers = await createWorkspaceClientProof(this.options.identity, {
          controllerNodeId: this.options.controllerNodeId, kind: "enrollment",
          method: "POST", path: MESH_RELAY_CLIENT_ENROLLMENT_PATH,
        });
        const stream = await this.openStream({ kind: "probe", path: MESH_RELAY_CLIENT_ENROLLMENT_PATH, headers });
        stream.close();
        await stream.waitUntilTransportClosed();
        stream.dispose();
        this.setDirectStatus("connected");
      } catch (error) {
        await this.stop();
        throw error;
      }
      return;
    }
    const relayUrl = normalizeMeshRelayOrigin(this.options.relayUrl);
    const refreshProtocol = async () => {
      const discovered = await discoverMeshEnrollmentTarget(relayUrl, { workspaceClient: true });
      const descriptor = discovered.descriptor;
      if (descriptor.role !== "relay"
        || descriptor.workspaceClientVersion !== MESH_RELAY_WORKSPACE_CLIENT_VERSION
        || descriptor.fingerprint !== this.options.relayFingerprint
        || descriptor.controllerNodeId !== this.options.controllerNodeId
        || descriptor.controllerFingerprint !== this.options.controllerFingerprint) {
        throw new DomainError("collaboration_relay_incompatible", "The relay does not support the invited controller and workspace client protocol.");
      }
      return discovered.negotiatedProtocolVersion;
    };
    this.lifetime = new AbortController();
    this.started = true;
    this.manager.start({
      config: {
        relayUrl,
        relayFingerprint: this.options.relayFingerprint,
        role: "client",
        targetNodeId: this.options.controllerNodeId,
        protocolVersion: MESH_PROTOCOL_VERSION,
        ...(this.options.enrollmentAdmission
          ? { enrollmentAdmission: this.options.enrollmentAdmission }
          : {}),
      },
      refreshProtocol,
      onStatusChange: (status) => this.options.onStatusChange?.(status),
    });
    if (options.waitForConnection === false) return;
    try {
      await this.manager.waitUntilConnected(10_000);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request(
    input: Omit<WorkspaceClientRequestMetadata, "version" | "nodeId" | "requestId" | "issuedAt" | "headers" | "controllerNodeId"> & {
      headers?: HeadersInit;
      body?: BodyInit | null;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const headers = await createWorkspaceClientProof(this.options.identity, {
      controllerNodeId: this.options.controllerNodeId,
      kind: input.kind,
      method: input.method,
      path: input.path,
      headers: input.headers,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.bodySha256 ? { bodySha256: input.bodySha256 } : {}),
    });
    headers[MESH_RELAY_RESPONSE_FLOW_HEADER] = "1";
    const stream = await this.openStream({
      kind: "http",
      method: "POST",
      path: input.kind === "enrollment" ? MESH_RELAY_CLIENT_ENROLLMENT_PATH : MESH_RELAY_CLIENT_OPERATION_PATH,
      headers,
      signal: input.signal,
    });
    return await performMeshRelayHttpRequest(stream, {
      body: input.body,
      signal: input.signal,
      responseFlowControl: true,
      logger: this.options.logger,
    });
  }

  async openSocket(
    input: Pick<WorkspaceClientRequestMetadata, "kind" | "path" | "workspaceId"> & {
      signal?: AbortSignal;
    },
  ): Promise<MeshRelayDataStream> {
    const headers = await createWorkspaceClientProof(this.options.identity, {
      controllerNodeId: this.options.controllerNodeId,
      kind: input.kind,
      method: "GET",
      path: input.path,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
    return await this.openStream({
      kind: "socket",
      path: MESH_RELAY_CLIENT_SOCKET_PATH,
      headers,
      signal: input.signal,
    });
  }

  private async openStream(input: {
    kind: "http" | "socket" | "probe";
    method?: string;
    path: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<MeshRelayDataStream> {
    if (!this.started) {
      throw new DomainError("collaboration_disconnected", "The workspace controller is disconnected.");
    }
    if (this.streams.size + this.opening.size >= 64) {
      throw new DomainError("collaboration_connection_capacity", "The workspace connection has too many active streams.");
    }
    const opening = this.openRuntimeStream(input);
    this.opening.add(opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(opening);
    }
  }

  private async openRuntimeStream(input: {
    kind: "http" | "socket" | "probe";
    method?: string;
    path: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<MeshRelayDataStream> {
    try {
      const signal = input.signal
        ? AbortSignal.any([input.signal, this.lifetime.signal])
        : this.lifetime.signal;
      const direct = this.options.controllerUrl !== undefined;
      const stream = this.options.controllerUrl !== undefined
        ? await openWorkspaceDirectStream({
          controllerUrl: this.options.controllerUrl,
          controller: { nodeId: this.options.controllerNodeId, publicKey: this.options.controllerPublicKey,
            fingerprint: this.options.controllerFingerprint },
          identity: this.options.identity, kind: input.kind, headers: input.headers,
          signal, logger: this.options.logger,
        })
        : await this.manager.resolveConnector({
        kind: "relay",
        targetNodeId: this.options.controllerNodeId,
        relayUrl: this.options.relayUrl,
        relayFingerprint: this.options.relayFingerprint,
      }).openStream({
        ...input,
        kind: input.kind === "probe" ? "http" : input.kind,
        signal,
      });
      const realtime = direct && input.kind === "socket"
        && readWorkspaceClientProof(new Headers(input.headers)).kind === "realtime";
      if (realtime) this.setDirectStatus("connected");
      this.streams.add(stream);
      void stream.waitUntilClosed()
        .then(() => {
          if (realtime && this.started) this.setDirectStatus("closed");
        })
        .then(() => stream.waitUntilTransportClosed())
        .then(() => this.streams.delete(stream))
        .catch((error: unknown) => {
          (this.options.logger ?? console).error("The workspace stream transport could not finish closing", {
            error: String(error),
          });
        });
      if (!this.started) {
        throw new DomainError("collaboration_disconnected", "The workspace controller is disconnected.");
      }
      return stream;
    } catch (error) {
      if (this.options.controllerUrl !== undefined && input.kind === "socket"
        && readWorkspaceClientProof(new Headers(input.headers)).kind === "realtime") this.setDirectStatus("closed");
      if (error instanceof MeshRelayStreamError && error.code === "mesh_relay_transport_cleanup_failed") {
        this.cleanupFailure = error;
      }
      // These fixed client gateway routes are denied when the relay withdraws admission.
      if (error instanceof MeshRelayStreamError && error.code === "mesh_relay_relay_route_forbidden") {
        throw new DomainError("collaboration_access_denied", "Workspace access has been revoked.", { cause: error });
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    const stopping = this.stopRuntime();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopRuntime(): Promise<void> {
    this.started = false;
    if (this.options.controllerUrl !== undefined) this.setDirectStatus("idle");
    this.lifetime.abort();
    await Promise.allSettled([...this.opening]);
    const streams = [...this.streams];
    const results = await Promise.allSettled([
      this.manager.stop(),
      ...streams.map(async (stream) => {
        stream.abort(1000, "Workspace connection stopped");
        try {
          await stream.waitUntilTransportClosed();
          this.streams.delete(stream);
        } finally {
          stream.dispose();
        }
      }),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (this.cleanupFailure) failures.push(this.cleanupFailure);
    if (failures.length > 0) throw new AggregateError(failures, "Workspace transport cleanup failed.");
  }
}
