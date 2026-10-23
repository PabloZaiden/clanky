/**
 * Workspace-authorized adapters for relay realtime, terminal and preview streams.
 */
import { createLogger, type RealtimeBus, type RealtimePublication } from "@pablozaiden/webapp/server";
import { realtimeClientMessageSchema, type CurrentUser } from "@pablozaiden/webapp/contracts";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import type { CollaborationGuestGrant, CollaborationRevocation } from "@/shared/collaboration";
import { MESH_TERMINAL_MAX_INPUT_BYTES } from "@/shared/mesh-terminal";
import { runWithCollaborationActor, runWithCurrentUser, runWithExecutionOwner, requireExecutionOwnerUser } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import { collaborationService } from "../core/collaboration-service";
import { workspaceClientController } from "../core/workspace-client-controller";
import type { MeshRelayInboundOptions } from "../core/mesh-relay-inbound";
import type { MeshInboundSocketAttachment } from "../core/mesh-inbound-socket";
import { findGuestResourceWorkspace, resolveWorkspaceEventAuthority } from "../core/workspace-event-authority";
import { previewSessionManager } from "../core/preview-session-manager";
import { isReadRecord } from "../core/resource-read-service";
import { isWorkspaceRealtimeEvent, type ClankyRealtimeEvent } from "../realtime";
import { workspaceGuestActor } from "./workspace-client-gateway";
import { startTerminalBridge, releaseTerminalSocket, type TerminalSocket } from "./websocket/terminal";

const log = createLogger("api:workspace-client-sockets");
type SocketInput = Parameters<NonNullable<MeshRelayInboundOptions["openWorkspaceClientSocket"]>>[0];
interface ActiveSocket {
  guestId: string;
  workspaceId?: string;
  close(): Promise<void>;
}

function parseFrame(raw: string | Uint8Array, maxBytes: number): unknown {
  if ((typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength) > maxBytes) {
    throw new DomainError("collaboration_request_invalid", "Workspace socket frame too large.");
  }
  try {
    return JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch (error) {
    throw new DomainError("collaboration_request_invalid", "Invalid workspace socket frame.", { cause: error });
  }
}

async function finishAll(operations: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Collaborator socket cleanup failed.");
}

class WorkspaceClientSockets {
  private realtime?: RealtimeBus<ClankyRealtimeEvent>;
  private readonly active = new Set<ActiveSocket>();
  private opening = 0;
  private stopping = false;
  private readonly pending = new Set<Promise<MeshInboundSocketAttachment>>();

  configure(realtime: RealtimeBus<ClankyRealtimeEvent>): void {
    this.realtime = realtime;
    this.stopping = false;
  }

  async open(input: SocketInput): Promise<MeshInboundSocketAttachment> {
    try {
      if (input.signal.aborted) throw input.signal.reason;
      if (this.stopping) throw new DomainError("collaboration_disconnected", "The controller is stopping.");
      if (this.active.size + this.opening >= 256) {
        throw new DomainError("collaboration_connection_capacity", "Too many active collaborator sockets.");
      }
      this.opening++;
      const opening = this.openAuthorized(input);
      this.pending.add(opening);
      try {
        return await opening;
      } finally {
        this.pending.delete(opening);
      }
    } catch (error) {
      const code = isDomainError(error) ? error.code : "collaboration_socket_failed";
      log[isDomainError(error) ? "warn" : "error"]("Collaborator socket rejected", { code, error: String(error) });
      try {
        input.socket.send(JSON.stringify({ type: "workspace.error", code }));
        input.socket.close(1008, "Workspace socket unavailable");
      } catch (sendError) {
        log.debug("Failed to notify a closed collaborator socket", { error: String(sendError) });
      }
      throw error;
    }
  }

  private async openAuthorized(input: SocketInput): Promise<MeshInboundSocketAttachment> {
    try {
      const guest = collaborationService.getAuthenticatedGuest(input.initiatorNodeId);
      if (!guest) throw new DomainError("collaboration_access_denied", "The client grant is unavailable.");
      const proof = await workspaceClientController.verifyProof({
        headers: new Headers(input.headers), initiatorNodeId: input.initiatorNodeId,
        publicKey: guest.identity.publicKey, secureTransport: input.secureTransport,
      });
      if (proof.method !== "GET" || proof.bodySha256 || Object.keys(proof.headers).length) {
        throw new DomainError("collaboration_request_invalid", "The socket proof is invalid.");
      }
      let attachment: MeshInboundSocketAttachment;
      let workspaceId = proof.workspaceId;
      if (proof.kind === "realtime" && proof.path === "/api/ws" && !workspaceId) {
        attachment = this.openRealtime(input, guest);
      } else if (proof.kind === "terminal") {
        const url = new URL(proof.path, "https://mesh.invalid");
        const id = url.pathname === "/api/terminal" ? url.searchParams.get("terminalSessionId") : null;
        workspaceId = id ? findGuestResourceWorkspace(guest, "terminal", id) : undefined;
        if (!id || !workspaceId) throw new DomainError("collaboration_resource_unavailable", "Terminal unavailable.");
        attachment = await this.openTerminal(input, guest, workspaceId, id);
      } else if (proof.kind === "preview" && proof.path === "/api/previews/bridge" && workspaceId) {
        attachment = this.openPreview(input, guest, workspaceId);
      } else throw new DomainError("collaboration_operation_denied", "This socket is not available to collaborators.");
      if (this.stopping || !collaborationService.getAuthenticatedGuest(guest.identity.nodeId)
        || workspaceId && !collaborationService.getGrantByNodeId(guest.identity.nodeId)?.workspaceIds.includes(workspaceId)) {
        await attachment.close();
        throw new DomainError(this.stopping ? "collaboration_disconnected" : "collaboration_access_denied",
          "The workspace socket is no longer available.");
      }
      let closing: Promise<void> | undefined;
      const active: ActiveSocket = {
        guestId: guest.id, workspaceId,
        close: () => closing ??= (async () => {
          input.signal.removeEventListener("abort", abort);
          try {
            await finishAll([
              (async () => { input.socket.close(1000, "Workspace stream closed"); })(),
              attachment.close(),
            ]);
          } finally {
            this.active.delete(active);
          }
        })(),
      };
      const abort = (): void => {
        void active.close().catch((error: unknown) => log.error("Collaborator socket cleanup failed", { error: String(error) }));
      };
      this.active.add(active);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) await active.close();
      return { ...attachment, close: active.close };
    } finally {
      this.opening--;
    }
  }

  private run<T>(guest: CollaborationGuestGrant, workspaceId: string, operation: () => T): T {
    return runWithCurrentUser(workspaceGuestActor(guest), () => runWithCollaborationActor(
      { kind: "guest", guestId: guest.id, nodeId: guest.identity.nodeId },
      () => collaborationService.withWorkspaceAccess(workspaceId, operation),
    ));
  }

  private openRealtime(input: SocketInput, guest: CollaborationGuestGrant): MeshInboundSocketAttachment {
    const realtime = this.realtime;
    if (!realtime) throw new Error("Workspace realtime is not configured.");
    let publication: RealtimePublication<unknown> | undefined;
    const transport = {
      data: { userId: guest.ownerUserId },
      send: (raw: string): void => {
        const frame: unknown = JSON.parse(raw);
        if (frame && typeof frame === "object" && "type" in frame && frame.type === "event") {
          if (!publication) throw new Error("Workspace publication metadata is missing.");
          input.socket.send(JSON.stringify({ type: "workspace.publication", publication }));
          publication = undefined;
        } else input.socket.send(raw);
      },
      close: (code?: number, reason?: string) => input.socket.close(code, reason),
      getBufferedAmount: () => 0,
    };
    realtime.add(transport, {
      authorize: (value) => {
        if (value.target.userId === guest.ownerUserId && value.target.resource === "workspaces"
          && value.target.id && guest.workspaceIds.includes(value.target.id)
          && isWorkspaceRealtimeEvent(value.event) && value.event.type === "workspaces.deleted") {
          input.socket.close(1000, "Workspace grants changed");
          return false;
        }
        const current = collaborationService.getGrantByNodeId(guest.identity.nodeId);
        return Boolean(current && !current.revokedAt && isWorkspaceRealtimeEvent(value.event)
          && resolveWorkspaceEventAuthority(current, value));
      },
      transform: (value) => {
        const workspaceId = resolveWorkspaceEventAuthority(guest, value);
        if (!workspaceId || !isWorkspaceRealtimeEvent(value.event)) return undefined;
        publication = { ...value, target: { ...value.target, workspaceId } };
        return { ...value, event: value.event };
      },
    });
    try {
      input.socket.send(JSON.stringify({
        type: "workspace.ready", guestId: guest.id,
        ownerUserId: guest.ownerUserId, workspaceIds: guest.workspaceIds,
      }));
    } catch (error) {
      realtime.remove(transport);
      throw error;
    }
    return {
      path: "/api/ws", sessionId: guest.id,
      message: async (data) => {
        if (!collaborationService.getAuthenticatedGuest(guest.identity.nodeId)) {
          throw new DomainError("collaboration_access_denied", "The client grant is unavailable.");
        }
        const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parsed = realtimeClientMessageSchema.safeParse(parseFrame(data, 128 * 1_024));
        if (parsed.success && parsed.data.type === "subscribe") {
          const { interest } = parsed.data;
          const references = [
            ...(interest.ids ?? []), ...(interest.scopes ?? []),
            ...Object.values(interest.targets ?? {}).flatMap((value) => Array.isArray(value) ? value : [value]),
          ];
          if (references.some((value) => decodeCollaborationResourceReference(value))) {
            throw new DomainError("collaboration_mixed_sources", "Transitive realtime subscriptions are not available.");
          }
        }
        realtime.message(transport, raw);
      },
      close: async () => realtime.remove(transport),
    };
  }

  private async openTerminal(
    input: SocketInput, guest: CollaborationGuestGrant, workspaceId: string, id: string,
  ): Promise<MeshInboundSocketAttachment> {
    const actor = workspaceGuestActor(guest);
    const terminal: TerminalSocket = {
      data: { terminalSessionId: id, user: actor },
      send: (data) => input.socket.send(data),
      close: (code, reason) => input.socket.close(code, reason),
    };
    const close = async (): Promise<void> => {
      releaseTerminalSocket(id, terminal);
      terminal.data.terminalAttachment?.release();
      await terminal.data.terminalBridge?.dispose();
    };
    try {
      await this.run(guest, workspaceId, async () => {
        collaborationService.authorizeInteractiveResource({ kind: "terminal", id, workspaceId });
        await startTerminalBridge(terminal);
        if (!terminal.data.terminalBridge) {
          throw new DomainError("collaboration_terminal_failed", "The terminal connection failed.");
        }
      });
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Collaborator terminal startup and cleanup failed.", { cause: error });
      }
      throw error;
    }
    return {
      path: "/api/terminal", sessionId: id,
      message: async (raw) => await this.run(guest, workspaceId, async () => {
        collaborationService.authorizeInteractiveResource({ kind: "terminal", id, workspaceId });
        const frame = parseFrame(raw, MESH_TERMINAL_MAX_INPUT_BYTES + 4_096);
        if (!frame || typeof frame !== "object" || !("type" in frame)) {
          throw new DomainError("collaboration_request_invalid", "Invalid terminal frame.");
        }
        if (frame.type === "terminal.input" && "data" in frame && typeof frame.data === "string") {
          if (Buffer.byteLength(frame.data) > MESH_TERMINAL_MAX_INPUT_BYTES) {
            throw new DomainError("collaboration_request_invalid", "Terminal input too large.");
          }
          await terminal.data.terminalBridge?.sendInput(frame.data);
        } else if (frame.type === "terminal.resize" && "cols" in frame && "rows" in frame
          && typeof frame.cols === "number" && typeof frame.rows === "number"
          && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)
          && frame.cols > 0 && frame.rows > 0 && frame.cols <= 1_000 && frame.rows <= 1_000) {
          await terminal.data.terminalBridge?.resize(frame.cols, frame.rows);
        } else if (frame.type === "ping") input.socket.send(JSON.stringify({ type: "pong" }));
        else throw new DomainError("collaboration_request_invalid", "Invalid terminal frame.");
      }),
      close,
    };
  }

  private openPreview(input: SocketInput, guest: CollaborationGuestGrant, workspaceId: string): MeshInboundSocketAttachment {
    let owner: CurrentUser | undefined;
    this.run(guest, workspaceId, () => { owner = requireExecutionOwnerUser(); });
    const preview = {
      data: { user: workspaceGuestActor(guest), previewBridgeUserId: `workspace-guest:${guest.id}` },
      send: (data: string | Uint8Array) => input.socket.send(data),
      close: (code?: number, reason?: string) => input.socket.close(code, reason),
    };
    return {
      path: "/api/previews/bridge", sessionId: crypto.randomUUID(),
      message: async (raw) => await this.run(guest, workspaceId, async () => {
        const frame = parseFrame(raw, 1_048_576);
        if (isReadRecord(frame) && frame["type"] === "hello") {
          if (!isReadRecord(frame["target"]) || frame["target"]["kind"] !== "workspace"
            || frame["target"]["reference"] !== workspaceId) {
            throw new DomainError("collaboration_operation_forbidden", "The preview must use its authorized workspace.");
          }
        }
        await previewSessionManager.handleBridgeMessage(preview, typeof raw === "string" ? raw : Buffer.from(raw));
      }),
      close: async () => {
        if (!owner) throw new Error("Preview execution owner is missing.");
        await runWithExecutionOwner(owner, async () => await previewSessionManager.closeBridgeSession(preview, "Workspace stream disconnected"));
      },
    };
  }

  async revoke(event: CollaborationRevocation): Promise<void> {
    await this.closeSockets([...this.active].filter((item) => item.guestId === event.guestId
      && (!item.workspaceId || event.workspaceIds.includes(item.workspaceId))));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
    await this.closeSockets([...this.active]);
  }

  private async closeSockets(sockets: ActiveSocket[]): Promise<void> {
    await finishAll(sockets.map(async (item) => await item.close()));
  }
}

export const workspaceClientSockets = new WorkspaceClientSockets();
