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
import { MeshRelayConnectorManager } from "./mesh-relay-connector-manager";
import type { MeshRelayConnectorIdentity, MeshRelayConnectorStatus } from "./mesh-relay-connector";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";
import { performMeshRelayHttpRequest } from "./mesh-relay-http";
import { MESH_RELAY_RESPONSE_FLOW_HEADER } from "./mesh-relay-http-response-flow";
import { createWorkspaceClientProof } from "./workspace-client-proof";
import { discoverMeshEnrollmentTarget } from "./mesh-target-discovery";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { MeshRelayStreamError } from "./mesh-relay-errors";

export interface MeshWorkspaceClientOptions {
  identity: MeshRelayConnectorIdentity;
  controllerNodeId: string;
  controllerFingerprint: string;
  relayUrl: string;
  relayFingerprint: string;
  enrollmentAdmission?: string;
  onStatusChange?(status: MeshRelayConnectorStatus): void;
}

export class MeshWorkspaceClient {
  private readonly manager: MeshRelayConnectorManager;
  private readonly streams = new Set<MeshRelayDataStream>();
  private opening = 0;
  private started = false;

  constructor(private readonly options: MeshWorkspaceClientOptions) {
    this.manager = new MeshRelayConnectorManager({
      identity: options.identity,
      manageTransport: false,
    });
  }

  get status(): MeshRelayConnectorStatus {
    return this.manager.status;
  }

  async start(options: { waitForConnection?: boolean } = {}): Promise<void> {
    if (this.started) {
      throw new DomainError("collaboration_connection_busy", "The workspace connection is already running.");
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
      dispatch: async () => new Response("Workspace clients do not serve inbound operations.", { status: 403 }),
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
    kind: "http" | "socket";
    method?: string;
    path: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<MeshRelayDataStream> {
    if (!this.started) {
      throw new DomainError("collaboration_disconnected", "The workspace controller is disconnected.");
    }
    if (this.streams.size + this.opening >= 64) {
      throw new DomainError("collaboration_connection_capacity", "The workspace connection has too many active streams.");
    }
    this.opening += 1;
    try {
      const connector = this.manager.resolveConnector({
        kind: "relay",
        targetNodeId: this.options.controllerNodeId,
        relayUrl: this.options.relayUrl,
        relayFingerprint: this.options.relayFingerprint,
      });
      const stream = await connector.openStream(input);
      if (!this.started) {
        stream.close(1000, "Workspace connection stopped");
        stream.dispose();
        throw new DomainError("collaboration_disconnected", "The workspace controller is disconnected.");
      }
      this.streams.add(stream);
      void stream.waitUntilClosed().then(() => this.streams.delete(stream));
      return stream;
    } catch (error) {
      // These fixed client gateway routes are denied when the relay withdraws admission.
      if (error instanceof MeshRelayStreamError && error.code === "mesh_relay_relay_route_forbidden") {
        throw new DomainError("collaboration_access_denied", "Workspace access has been revoked.", { cause: error });
      }
      throw error;
    } finally {
      this.opening -= 1;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const stream of this.streams) {
      stream.close(1000, "Workspace connection stopped");
      stream.dispose();
    }
    this.streams.clear();
    await this.manager.stop();
  }
}
