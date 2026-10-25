/**
 * User-context and server-lifecycle adapter for the portable invited client.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { CollaborationConnection, WorkspaceConnectionStatus } from "@/shared/collaboration";
import type { CollaborationResourceReference } from "@/shared/collaboration-reference";
import {
  CollaborationClientEngine, type CollaborationClientRuntime,
} from "../client-sdk/collaboration/engine";
import { requireCurrentUser, requireCurrentUserId } from "../context/user-context";
import { BunCollaborationPairingStore } from "./collaboration-client-store";
import { collaborationService } from "./collaboration-service";

const log = createLogger("core:workspace-connections");

export type WorkspaceConnectionRuntime = CollaborationClientRuntime;

class WorkspaceConnections {
  private readonly engines = new Map<string, CollaborationClientEngine>();
  private unsubscribe?: () => void;
  private changed?: (userId: string) => void;
  private runtimeChanged?: (runtime: WorkspaceConnectionRuntime) => void;
  private runtimeStopped?: (connectionId: string) => void | Promise<void>;

  configure(input: {
    changed(userId: string): void;
    runtimeChanged(runtime: WorkspaceConnectionRuntime): void;
    runtimeStopped(connectionId: string): void | Promise<void>;
  }): void {
    this.changed = input.changed;
    this.runtimeChanged = input.runtimeChanged;
    this.runtimeStopped = input.runtimeStopped;
  }

  private forUser(userId: string): CollaborationClientEngine {
    let engine = this.engines.get(userId);
    if (!engine) {
      engine = new CollaborationClientEngine({
        store: new BunCollaborationPairingStore(userId), logger: log,
        changed: () => this.changed?.(userId),
        runtimeChanged: (runtime) => this.runtimeChanged?.(runtime),
        runtimeStopped: (connectionId) => this.runtimeStopped?.(connectionId),
      });
      this.engines.set(userId, engine);
    }
    return engine;
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = collaborationService.onConnectionChanged((event) => {
      if (event.status !== "active") {
        const engine = this.engines.get(event.localUserId);
        // Persistence events also arrive outside HTTP; this lifecycle owns and
        // reports asynchronous transport cleanup independently of the request.
        if (engine) void engine.invalidate(event.connectionId).catch((error: unknown) => {
          log.error("Workspace transport cleanup failed", { error: String(error) });
        });
      }
      this.changed?.(event.localUserId);
    });
    await Promise.all(collaborationService.listActiveConnectionsInternal().map(async ({ localUserId, connection }) => {
      try {
        await this.forUser(localUserId).open(connection.id, { waitForConnection: false });
      } catch (error) {
        log.error("A workspace pairing could not start", { connectionId: connection.id, error: String(error) });
      }
    }));
  }

  async reportFailure(runtime: WorkspaceConnectionRuntime, code: string): Promise<void> {
    await this.engines.get(runtime.scope)?.reportFailure(runtime, code);
  }

  reportHealthy(runtime: WorkspaceConnectionRuntime): void {
    this.engines.get(runtime.scope)?.reportHealthy(runtime);
  }

  reportOperation(connectionId: string, operation: string, code: string | null): void {
    this.forUser(requireCurrentUserId()).reportOperation(connectionId, operation, code);
  }

  list(): WorkspaceConnectionStatus[] {
    return this.forUser(requireCurrentUserId()).describe(collaborationService.listConnections());
  }

  forCurrentUser(): WorkspaceConnectionRuntime[] {
    return this.forUser(requireCurrentUserId()).activeRuntimes();
  }

  require(connectionId: string): WorkspaceConnectionRuntime {
    return this.forUser(requireCurrentUserId()).require(connectionId);
  }

  async requireWorkspaceReference(reference: CollaborationResourceReference): Promise<void> {
    await this.forUser(requireCurrentUserId()).requireWorkspaceReference(reference);
  }

  async accept(input: { invitation: string; name?: string }): Promise<CollaborationConnection> {
    const user = requireCurrentUser();
    return await this.forUser(user.id).accept({ ...input, guestName: user.username });
  }

  async recover(connectionId: string): Promise<CollaborationConnection> {
    const user = requireCurrentUser();
    return await this.forUser(user.id).recover(connectionId, user.username);
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.forUser(requireCurrentUserId()).forget(connectionId);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const engines = [...this.engines.values()];
    const results = await Promise.allSettled(engines.map((engine) => engine.stop()));
    this.engines.clear();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Workspace connections could not finish shutdown.");
  }
}

export const workspaceConnections = new WorkspaceConnections();
