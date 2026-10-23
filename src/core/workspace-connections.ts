/**
 * Maintains each user's outbound controller connections without content replicas.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { CollaborationGuestGrantSchema } from "@/contracts/schemas/collaboration";
import type { CollaborationConnection, WorkspaceConnectionStatus } from "@/shared/collaboration";
import { requireCurrentUser, requireCurrentUserId, runWithCurrentUser } from "../context/user-context";
import { getCollaborationOwnerUser } from "../persistence/collaboration-storage";
import { DomainError } from "../domain/domain-error";
import { collaborationService } from "./collaboration-service";
import { MeshWorkspaceClient } from "./mesh-workspace-client";
import { decodeWorkspaceInvitation } from "./workspace-client-proof";
import { MESH_RELAY_CLIENT_ENROLLMENT_PATH } from "@/shared/mesh-relay";
import type { CollaborationResourceReference } from "@/shared/collaboration-reference";

const log = createLogger("core:workspace-connections");

export interface WorkspaceConnectionRuntime {
  localUserId: string;
  connection: CollaborationConnection;
  client: MeshWorkspaceClient;
  errorCode: string | null;
  operationErrorCode: string | null;
  operationErrors: Map<string, string>;
  realtime: WorkspaceConnectionStatus["realtime"];
}

class WorkspaceConnections {
  private readonly runtimes = new Map<string, WorkspaceConnectionRuntime>();
  private readonly closing = new Set<Promise<void>>();
  private readonly startupErrors = new Map<string, string>();
  private unsubscribe?: () => void;
  private changed?: (userId: string) => void;
  private runtimeChanged?: (runtime: WorkspaceConnectionRuntime) => void;
  private runtimeStopped?: (connectionId: string) => void;

  configure(input: {
    changed(userId: string): void;
    runtimeChanged(runtime: WorkspaceConnectionRuntime): void;
    runtimeStopped(connectionId: string): void;
  }): void {
    this.changed = input.changed;
    this.runtimeChanged = input.runtimeChanged;
    this.runtimeStopped = input.runtimeStopped;
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = collaborationService.onConnectionChanged((event) => {
      if (event.status !== "active") {
        const runtime = this.runtimes.get(event.connectionId);
        this.runtimes.delete(event.connectionId);
        this.startupErrors.delete(event.connectionId);
        // Transport maintenance owns failures and exposes them independently of HTTP.
        if (runtime) void this.closeRuntime(runtime).catch((error: unknown) => {
          log.error("Workspace transport cleanup failed", { error: String(error) });
        });
      }
      this.changed?.(event.localUserId);
    });
    await Promise.all(collaborationService.listActiveConnectionsInternal().map(async ({ localUserId, connection }) => {
      try {
        await this.open(connection.id, localUserId, { waitForConnection: false });
      } catch (error) {
        this.startupErrors.set(connection.id, "collaboration_identity_unavailable");
        log.error("A workspace pairing could not start", { connectionId: connection.id, error: String(error) });
        this.changed?.(localUserId);
      }
    }));
  }

  reportFailure(runtime: WorkspaceConnectionRuntime, code: string): void {
    if (this.runtimes.get(runtime.connection.id) !== runtime) return;
    runtime.errorCode = code;
    runtime.realtime = "disconnected";
    if (code === "collaboration_access_denied") {
      const user = getCollaborationOwnerUser(runtime.localUserId);
      if (user) runWithCurrentUser(user, () => collaborationService.revokeConnection(runtime.connection.id));
      else log.warn("The local pairing owner is unavailable", { connectionId: runtime.connection.id });
    }
    this.changed?.(runtime.localUserId);
  }

  reportHealthy(runtime: WorkspaceConnectionRuntime): void {
    if (this.runtimes.get(runtime.connection.id) !== runtime
      || runtime.errorCode === null && runtime.realtime === "connected") return;
    runtime.errorCode = null;
    runtime.realtime = "connected";
    this.changed?.(runtime.localUserId);
  }

  reportOperation(connectionId: string, operation: string, code: string | null): void {
    const runtime = this.runtimes.get(connectionId);
    if (!runtime || runtime.localUserId !== requireCurrentUserId()) return;
    if (code) runtime.operationErrors.set(operation, code);
    else runtime.operationErrors.delete(operation);
    const next = runtime.operationErrors.values().next().value ?? null;
    if (runtime.operationErrorCode === next) return;
    runtime.operationErrorCode = next;
    this.changed?.(runtime.localUserId);
  }

  list(): WorkspaceConnectionStatus[] {
    return collaborationService.listConnections().map((connection) => {
      const runtime = this.runtimes.get(connection.id);
      return {
        connection,
        transport: runtime?.client.status ?? "idle",
        realtime: runtime?.realtime ?? "disconnected",
        errorCode: runtime?.errorCode ?? this.startupErrors.get(connection.id) ?? null,
        operationErrorCode: runtime?.operationErrorCode ?? null,
      };
    });
  }

  forCurrentUser(): WorkspaceConnectionRuntime[] {
    const userId = requireCurrentUserId();
    return [...this.runtimes.values()].filter((runtime) => (
      runtime.localUserId === userId && runtime.connection.status === "active"
    ));
  }

  require(connectionId: string): WorkspaceConnectionRuntime {
    const runtime = this.runtimes.get(connectionId);
    if (!runtime || runtime.localUserId !== requireCurrentUserId()
      || runtime.connection.status !== "active") {
      throw new DomainError("collaboration_connection_unavailable", "The workspace connection is unavailable.");
    }
    if (runtime.client.status !== "connected") {
      throw new DomainError("collaboration_disconnected", "The workspace controller is disconnected.");
    }
    return runtime;
  }

  async requireWorkspaceReference(reference: CollaborationResourceReference): Promise<void> {
    if (reference.resourceKind !== "workspace") {
      throw new DomainError("collaboration_reference_invalid", "A workspace reference is required.");
    }
    const runtime = this.require(reference.connectionId);
    const response = await runtime.client.request({
      kind: "operation", method: "GET",
      path: `/api/workspaces/${encodeURIComponent(reference.resourceId)}`,
      signal: AbortSignal.timeout(20_000),
    });
    try {
      if (response.status === 403 || response.status === 404) {
        throw new DomainError("collaboration_workspace_unavailable", "The shared workspace is unavailable.");
      }
      if (!response.ok) throw new DomainError("collaboration_disconnected", "The workspace controller is unavailable.");
    } finally {
      await response.body?.cancel();
    }
  }

  async accept(input: { invitation: string; name?: string }): Promise<CollaborationConnection> {
    const invitation = decodeWorkspaceInvitation(input.invitation.trim());
    const user = requireCurrentUser();
    let connection = collaborationService.listConnections().find((candidate) => (
      candidate.status === "pending"
      && candidate.controller.nodeId === invitation.controller.nodeId
      && candidate.controller.fingerprint === invitation.controller.fingerprint
      && candidate.relayUrl === invitation.relay.url
      && candidate.relayFingerprint === invitation.relay.fingerprint
    ));
    connection ??= await collaborationService.createPendingConnection({
      name: input.name ?? invitation.controller.name,
      controller: {
        nodeId: invitation.controller.nodeId,
        publicKey: invitation.controller.publicKey,
        fingerprint: invitation.controller.fingerprint,
      },
      relayUrl: invitation.relay.url,
      relayFingerprint: invitation.relay.fingerprint,
    });
    const runtime = await this.open(connection.id, user.id, {
      admission: invitation.relayAdmission, waitForConnection: true,
    });
    return await this.enroll(runtime, { token: invitation.token, name: user.username });
  }

  async recover(connectionId: string): Promise<CollaborationConnection> {
    const runtime = await this.open(connectionId, requireCurrentUserId(), { waitForConnection: true });
    return await this.enroll(runtime, { name: requireCurrentUser().username });
  }

  private async enroll(
    runtime: WorkspaceConnectionRuntime,
    input: { token?: string; name: string },
  ): Promise<CollaborationConnection> {
    const body = JSON.stringify({
      ...input, guest: runtime.connection.identity,
      relayUrl: runtime.connection.relayUrl,
      relayFingerprint: runtime.connection.relayFingerprint,
    });
    const response = await runtime.client.request({
      kind: "enrollment", method: "POST", path: MESH_RELAY_CLIENT_ENROLLMENT_PATH,
      body, bodySha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError("collaboration_enrollment_failed", "The controller could not complete pairing.", {
        details: { status: response.status },
      });
    }
    const grant = CollaborationGuestGrantSchema.parse(await response.json());
    const active = collaborationService.activateConnection(runtime.connection.id, grant);
    runtime.connection = active;
    this.changed?.(runtime.localUserId);
    this.runtimeChanged?.(runtime);
    return active;
  }

  private async open(
    connectionId: string,
    localUserId: string,
    options: { admission?: string; waitForConnection: boolean },
  ): Promise<WorkspaceConnectionRuntime> {
    this.startupErrors.delete(connectionId);
    const previous = this.runtimes.get(connectionId);
    if (previous?.localUserId === localUserId && previous.client.status === "connected") return previous;
    if (previous) {
      this.runtimes.delete(connectionId);
      await this.closeRuntime(previous);
    }
    const identity = await collaborationService.loadConnectionIdentityInternal(connectionId, localUserId);
    let runtime: WorkspaceConnectionRuntime | undefined;
    const client = new MeshWorkspaceClient({
      identity: { ...identity.connection.identity, sign: async (payload) => identity.sign(payload) },
      controllerNodeId: identity.connection.controller.nodeId,
      controllerFingerprint: identity.connection.controller.fingerprint,
      relayUrl: identity.connection.relayUrl,
      relayFingerprint: identity.connection.relayFingerprint,
      enrollmentAdmission: options.admission,
      onStatusChange: () => {
        if (runtime) runtime.realtime = client.status === "connected" ? "connecting" : "disconnected";
        this.changed?.(localUserId);
        if (runtime) this.runtimeChanged?.(runtime);
      },
    });
    runtime = {
      localUserId, connection: identity.connection, client, errorCode: null,
      operationErrorCode: null, operationErrors: new Map(), realtime: "connecting",
    };
    this.runtimes.set(connectionId, runtime);
    try {
      await client.start({ waitForConnection: options.waitForConnection });
      this.runtimeChanged?.(runtime);
      return runtime;
    } catch (error) {
      this.runtimes.delete(connectionId);
      try {
        await this.closeRuntime(runtime);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Workspace connection startup and cleanup failed.", { cause: error });
      }
      throw error;
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    const owned = collaborationService.listConnections().some((connection) => connection.id === connectionId);
    if (!owned) {
      throw new DomainError("collaboration_connection_unavailable", "The workspace connection is unavailable.");
    }
    const runtime = this.runtimes.get(connectionId);
    if (runtime) {
      this.runtimes.delete(connectionId);
      await this.closeRuntime(runtime);
    }
    collaborationService.deleteConnection(connectionId);
    this.startupErrors.delete(connectionId);
  }

  private closeRuntime(runtime: WorkspaceConnectionRuntime): Promise<void> {
    const pending = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.runtimeStopped?.(runtime.connection.id)),
        runtime.client.stop(),
      ]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Workspace connection cleanup failed.");
    })().finally(() => this.closing.delete(pending));
    this.closing.add(pending);
    return pending;
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.startupErrors.clear();
    const results = await Promise.allSettled([
      ...this.closing,
      ...runtimes.map((runtime) => this.closeRuntime(runtime)),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Workspace connections could not finish shutdown.");
  }
}

export const workspaceConnections = new WorkspaceConnections();
