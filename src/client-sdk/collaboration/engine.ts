/**
 * The invited client's pairing, recovery and outbound runtime owner.
 */

import type { CollaborationConnection, WorkspaceConnectionStatus } from "@/shared/collaboration";
import { COLLABORATION_MAX_CONNECTIONS } from "@/shared/collaboration";
import type { CollaborationResourceReference } from "@/shared/collaboration-reference";
import { MESH_RELAY_CLIENT_ENROLLMENT_PATH } from "@/shared/mesh-relay";
import { DomainError, isDomainError } from "../../domain/domain-error";
import { MeshWorkspaceClient } from "../../core/mesh-workspace-client";
import { readWorkspaceRequestBytes } from "./bodies";
import { sha256Hex } from "./crypto";
import { utf8Bytes } from "@/shared/encoding";
import { assertCollaborationPairingUsable, validateCollaborationPairingGrant } from "./pairing-state";
import { decodeWorkspaceInvitation } from "./proof";
import type {
  CollaborationConnectionLease, CollaborationConnectionOwnership,
  CollaborationPairingStore,
} from "./store";
import type { CollaborationClientLogger } from "./types";

const MAX_OPERATION_ERRORS = 128;
const MAX_GRANT_BYTES = 64 * 1_024;

export interface CollaborationClientRuntime {
  scope: string;
  connection: CollaborationConnection;
  client: MeshWorkspaceClient;
  errorCode: string | null;
  operationErrorCode: string | null;
  operationErrors: Map<string, string>;
  realtime: WorkspaceConnectionStatus["realtime"];
}

export interface CollaborationClientEngineOptions {
  store: CollaborationPairingStore;
  ownership?: CollaborationConnectionOwnership;
  logger?: CollaborationClientLogger;
  changed?(): void;
  runtimeChanged?(runtime: CollaborationClientRuntime): void;
  runtimeStopped?(connectionId: string): void | Promise<void>;
}

export class CollaborationClientEngine {
  private readonly runtimes = new Map<string, CollaborationClientRuntime>();
  private readonly leases = new Map<string, CollaborationConnectionLease>();
  private readonly closing = new Map<CollaborationClientRuntime, Promise<void>>();
  private readonly cleanupFailures = new Map<string, unknown>();
  private readonly startupErrors = new Map<string, string>();
  private readonly invalidations = new Map<string, number>();
  private readonly flights = new Map<string, Promise<CollaborationConnection>>();
  private readonly lifetime = new AbortController();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private disposed = false;
  private stopping?: Promise<void>;
  private readonly log: CollaborationClientLogger;

  constructor(private readonly options: CollaborationClientEngineOptions) {
    this.log = options.logger ?? console;
  }

  describe(connections: readonly CollaborationConnection[]): WorkspaceConnectionStatus[] {
    return connections.map((connection) => {
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

  async list(): Promise<WorkspaceConnectionStatus[]> {
    return this.describe(await this.options.store.list());
  }

  activeRuntimes(): CollaborationClientRuntime[] {
    return [...this.runtimes.values()].filter((runtime) => runtime.connection.status === "active");
  }

  require(connectionId: string): CollaborationClientRuntime {
    this.assertActive(connectionId);
    const runtime = this.runtimes.get(connectionId);
    if (!runtime || runtime.connection.status !== "active") {
      throw new DomainError("collaboration_connection_unavailable", "The workspace connection is unavailable.");
    }
    if (runtime.client.status !== "connected") {
      throw new DomainError("collaboration_disconnected", "The workspace controller is disconnected.");
    }
    return runtime;
  }

  async open(connectionId: string, options: { waitForConnection: boolean }): Promise<CollaborationClientRuntime> {
    return await this.enqueue(() => this.openRuntime(connectionId, options));
  }

  async accept(input: { invitation: string; name?: string; guestName: string }): Promise<CollaborationConnection> {
    this.assertActive();
    const invitation = await decodeWorkspaceInvitation(input.invitation.trim());
    this.assertActive();
    const destination = JSON.stringify([
      invitation.controller.nodeId, invitation.controller.fingerprint,
      invitation.relay.url, invitation.relay.fingerprint,
    ]);
    return await this.singleFlight(`accept:${destination}:${invitation.token}`, () => this.enqueue(async () => {
      const destinationLease = await this.options.ownership?.acquire("destination", destination);
      try {
        this.assertActive();
        let connection = (await this.options.store.list()).find((candidate) => (
          candidate.status === "pending"
          && Date.parse(candidate.pendingExpiresAt) > Date.now()
          && candidate.controller.nodeId === invitation.controller.nodeId
          && candidate.controller.fingerprint === invitation.controller.fingerprint
          && candidate.relayUrl === invitation.relay.url
          && candidate.relayFingerprint === invitation.relay.fingerprint
        ));
        this.assertActive();
        if (!connection) {
          const pending = await this.options.store.createPending({
            name: input.name ?? invitation.controller.name,
            controller: {
              nodeId: invitation.controller.nodeId, publicKey: invitation.controller.publicKey,
              fingerprint: invitation.controller.fingerprint,
            },
            relayUrl: invitation.relay.url, relayFingerprint: invitation.relay.fingerprint,
          });
          connection = pending.connection;
        }
        this.assertActive(connection.id);
        const runtime = await this.openRuntime(connection.id, {
          admission: invitation.relayAdmission, waitForConnection: true,
        });
        return await this.enroll(runtime, { token: invitation.token, name: input.guestName });
      } finally {
        await destinationLease?.release();
      }
    }));
  }

  async recover(connectionId: string, guestName: string): Promise<CollaborationConnection> {
    return await this.singleFlight(`recover:${connectionId}`, () => this.enqueue(async () => {
      const runtime = await this.openRuntime(connectionId, { waitForConnection: true });
      return await this.enroll(runtime, { name: guestName });
    }));
  }

  async requireWorkspaceReference(reference: CollaborationResourceReference): Promise<void> {
    if (reference.resourceKind !== "workspace") {
      throw new DomainError("collaboration_reference_invalid", "A workspace reference is required.");
    }
    const runtime = this.require(reference.connectionId);
    const response = await runtime.client.request({
      kind: "operation", method: "GET",
      path: `/api/workspaces/${encodeURIComponent(reference.resourceId)}`,
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20_000)]),
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

  async reportFailure(runtime: CollaborationClientRuntime, code: string): Promise<void> {
    if (this.runtimes.get(runtime.connection.id) !== runtime || this.disposed) return;
    runtime.errorCode = code;
    runtime.realtime = "disconnected";
    this.options.changed?.();
    if (code === "collaboration_access_denied") await this.retire(runtime.connection.id, "revoke");
  }

  reportHealthy(runtime: CollaborationClientRuntime): void {
    if (this.runtimes.get(runtime.connection.id) !== runtime || this.disposed
      || runtime.errorCode === null && runtime.realtime === "connected") return;
    runtime.errorCode = null;
    runtime.realtime = "connected";
    this.options.changed?.();
  }

  reportOperation(connectionId: string, operation: string, code: string | null): void {
    const runtime = this.runtimes.get(connectionId);
    if (!runtime || this.disposed) return;
    if (code) {
      if (!runtime.operationErrors.has(operation) && runtime.operationErrors.size >= MAX_OPERATION_ERRORS) {
        runtime.operationErrors.delete(runtime.operationErrors.keys().next().value!);
      }
      runtime.operationErrors.set(operation, code);
    } else runtime.operationErrors.delete(operation);
    const next = runtime.operationErrors.values().next().value ?? null;
    if (runtime.operationErrorCode === next) return;
    runtime.operationErrorCode = next;
    this.options.changed?.();
  }

  async forget(connectionId: string): Promise<void> {
    await this.retire(connectionId, "forget");
  }

  async invalidate(connectionId: string): Promise<void> {
    await this.retire(connectionId, "external");
  }

  private async enroll(
    runtime: CollaborationClientRuntime,
    input: { token?: string; name: string },
  ): Promise<CollaborationConnection> {
    const snapshot = await this.options.store.get(runtime.connection.id);
    this.assertRuntime(runtime);
    const body = JSON.stringify({
      ...input, guest: snapshot.connection.identity,
      relayUrl: snapshot.connection.relayUrl, relayFingerprint: snapshot.connection.relayFingerprint,
    });
    const bodySha256 = await sha256Hex(utf8Bytes(body));
    this.assertRuntime(runtime);
    const response = await runtime.client.request({
      kind: "enrollment", method: "POST", path: MESH_RELAY_CLIENT_ENROLLMENT_PATH,
      body, bodySha256, headers: { "content-type": "application/json" },
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError("collaboration_enrollment_failed", "The controller could not complete pairing.", {
        details: { status: response.status },
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await readWorkspaceRequestBytes(response, MAX_GRANT_BYTES),
      ));
    } catch (error) {
      throw new DomainError("collaboration_response_invalid", "The controller returned an invalid pairing response.", {
        cause: error,
      });
    }
    this.assertRuntime(runtime);
    const grant = await validateCollaborationPairingGrant(snapshot.connection, value);
    this.assertRuntime(runtime);
    const active = await this.options.store.activate(snapshot, grant);
    this.assertRuntime(runtime);
    runtime.connection = active.connection;
    this.options.changed?.();
    this.options.runtimeChanged?.(runtime);
    return active.connection;
  }

  private async openRuntime(
    connectionId: string,
    options: { admission?: string; waitForConnection: boolean },
  ): Promise<CollaborationClientRuntime> {
    this.assertActive(connectionId);
    if (this.cleanupFailures.has(connectionId)) {
      throw new DomainError("collaboration_transport_cleanup_failed", "The previous transport could not finish closing.", {
        cause: this.cleanupFailures.get(connectionId),
      });
    }
    let runtime = this.runtimes.get(connectionId);
    let persisted = false;
    try {
      const snapshot = await this.options.store.get(connectionId);
      persisted = true;
      await this.ensureOwnership(connectionId);
      this.assertActive(connectionId);
      assertCollaborationPairingUsable(snapshot.connection);
      if (runtime?.client.status === "connected") return runtime;
      if (runtime) {
        this.runtimes.delete(connectionId);
        await this.closeRuntime(runtime);
        this.assertActive(connectionId);
      }
      const identity = await this.options.store.loadIdentity(snapshot);
      this.assertActive(connectionId);
      const client = new MeshWorkspaceClient({
        identity, logger: this.log,
        controllerNodeId: snapshot.connection.controller.nodeId,
        controllerFingerprint: snapshot.connection.controller.fingerprint,
        relayUrl: snapshot.connection.relayUrl, relayFingerprint: snapshot.connection.relayFingerprint,
        enrollmentAdmission: options.admission,
        onStatusChange: () => {
          if (!runtime || this.disposed || this.runtimes.get(connectionId) !== runtime
            || this.invalidations.has(connectionId)) return;
          runtime.realtime = client.status === "connected" ? "connecting" : "disconnected";
          this.options.changed?.();
          this.options.runtimeChanged?.(runtime);
        },
      });
      runtime = {
        scope: this.options.store.scope, connection: snapshot.connection, client,
        errorCode: null, operationErrorCode: null, operationErrors: new Map(), realtime: "connecting",
      };
      this.runtimes.set(connectionId, runtime);
      this.startupErrors.delete(connectionId);
      await client.start({ waitForConnection: options.waitForConnection });
      this.assertRuntime(runtime);
      this.options.runtimeChanged?.(runtime);
      return runtime;
    } catch (error) {
      if (this.runtimes.get(connectionId) === runtime) this.runtimes.delete(connectionId);
      if (persisted || runtime) {
        this.startupErrors.set(connectionId, isDomainError(error) ? error.code : "collaboration_identity_unavailable");
      }
      try {
        if (runtime) await this.closeRuntime(runtime);
        if (!this.invalidations.has(connectionId)) await this.releaseOwnership(connectionId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Workspace connection startup and cleanup failed.", { cause: error });
      } finally {
        this.options.changed?.();
      }
      throw error;
    }
  }

  private async ensureOwnership(connectionId: string): Promise<void> {
    if (this.leases.has(connectionId) || !this.options.ownership) return;
    const lease = await this.options.ownership.acquire("connection", connectionId);
    try {
      this.assertActive();
    } catch (error) {
      await lease.release();
      throw error;
    }
    this.leases.set(connectionId, lease);
  }

  private async releaseOwnership(connectionId: string): Promise<void> {
    if (this.cleanupFailures.has(connectionId)) {
      throw new DomainError("collaboration_transport_cleanup_failed", "Connection ownership is retained because transport cleanup failed.", {
        cause: this.cleanupFailures.get(connectionId),
      });
    }
    const lease = this.leases.get(connectionId);
    if (!lease) return;
    await lease.release();
    this.leases.delete(connectionId);
  }

  private closeRuntime(runtime: CollaborationClientRuntime): Promise<void> {
    const previous = this.closing.get(runtime);
    if (previous) return previous;
    const operation = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.options.runtimeStopped?.(runtime.connection.id)),
        runtime.client.stop(),
      ]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) {
        const error = new AggregateError(failures, "Workspace connection cleanup failed.");
        this.cleanupFailures.set(runtime.connection.id, error);
        throw error;
      }
    })();
    this.closing.set(runtime, operation);
    void operation.then(() => this.closing.delete(runtime), () => {
      // Retain the failed close so disposal cannot release its transport lease.
    });
    return operation;
  }

  private async retire(connectionId: string, action: "forget" | "revoke" | "external"): Promise<void> {
    this.assertActive();
    this.invalidations.set(connectionId, (this.invalidations.get(connectionId) ?? 0) + 1);
    const runtime = this.runtimes.get(connectionId);
    this.runtimes.delete(connectionId);
    const closing = runtime ? this.closeRuntime(runtime) : Promise.resolve();
    // Observe teardown immediately even while another lifecycle operation settles.
    const cleanup = Promise.allSettled([closing]);
    try {
      await this.enqueue(async () => {
        if (action !== "external") {
          await this.ensureOwnership(connectionId);
          const snapshot = await this.options.store.get(connectionId);
          this.assertActive();
          if (action === "forget") await this.options.store.forget(snapshot);
          else if (snapshot.connection.status !== "revoked") await this.options.store.revoke(snapshot);
        }
        const [closed] = await cleanup;
        if (closed?.status === "rejected") throw closed.reason;
        await this.releaseOwnership(connectionId);
        this.startupErrors.delete(connectionId);
        this.options.changed?.();
      });
    } finally {
      const remaining = this.invalidations.get(connectionId)! - 1;
      if (remaining > 0) this.invalidations.set(connectionId, remaining);
      else this.invalidations.delete(connectionId);
    }
  }

  private assertActive(connectionId?: string): void {
    if (this.disposed || connectionId && this.invalidations.has(connectionId)) {
      throw new DomainError("collaboration_connection_inactive", "The connection lifecycle is no longer active.");
    }
  }

  private assertRuntime(runtime: CollaborationClientRuntime): void {
    this.assertActive(runtime.connection.id);
    if (this.runtimes.get(runtime.connection.id) !== runtime) {
      throw new DomainError("collaboration_connection_stale", "The connection was replaced while the operation was in progress.");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    if (this.pendingOperations >= COLLABORATION_MAX_CONNECTIONS) {
      throw new DomainError("collaboration_connection_capacity", "Too many pairing operations are pending.");
    }
    this.pendingOperations += 1;
    const pending = this.lifecycleTail.then(async () => {
      this.assertActive();
      return await operation();
    }).finally(() => { this.pendingOperations -= 1; });
    // The caller retains the rejecting operation; the tail represents completion.
    this.lifecycleTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private singleFlight(key: string, operation: () => Promise<CollaborationConnection>): Promise<CollaborationConnection> {
    this.assertActive();
    const previous = this.flights.get(key);
    if (previous) return previous;
    const pending = operation().finally(() => {
      if (this.flights.get(key) === pending) this.flights.delete(key);
    });
    this.flights.set(key, pending);
    return pending;
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    this.disposed = true;
    this.lifetime.abort();
    this.stopping = this.stopRuntime();
    return await this.stopping;
  }

  private async stopRuntime(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    const closing = [...this.closing.values(), ...runtimes.map((runtime) => this.closeRuntime(runtime))];
    const results = await Promise.allSettled([this.lifecycleTail, ...closing]);
    const releases = await Promise.allSettled([...this.leases.keys()].map((id) => this.releaseOwnership(id)));
    const failures = [...results, ...releases].flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    this.startupErrors.clear();
    if (failures.length > 0) throw new AggregateError(failures, "Workspace connections could not finish shutdown.");
  }
}
