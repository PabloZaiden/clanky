import type { ServerWebSocket } from "bun";
import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import {
  WORKSPACE_DIRECT_PATH, WorkspaceDirectOpenSchema,
} from "@/contracts/schemas/mesh-client";
import {
  MESH_RELAY_CLIENT_ENROLLMENT_PATH, MESH_RELAY_CLIENT_OPERATION_PATH, MESH_RELAY_CLIENT_SOCKET_PATH,
} from "@/shared/mesh-relay";
import { DomainError, isDomainError } from "../domain/domain-error";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { workspaceClientController } from "../core/workspace-client-controller";
import { MeshRelayDataStream } from "../core/mesh-relay-data-stream";
import {
  fromMeshRelayCloseCode, waitForMeshRelaySocketClosed, type MeshRelayClientSocket,
} from "../core/mesh-relay-client-socket";
import { serveMeshRelayHttpStream } from "../core/mesh-relay-http";
import { serveSocketStream } from "../core/mesh-relay-inbound";
import { isSecureMeshRequest } from "../core/mesh-transport-security";
import { workspaceClientSockets } from "./workspace-client-sockets";
import { dispatchWorkspaceClient, enrollWorkspaceClient } from "./workspace-client-gateway";

const log = createLogger("api:workspace-direct");
const sessions = new Set<DirectSession>();
const MAX_SESSIONS = 256;
const MAX_OPEN_BYTES = 64 * 1_024;

interface DirectSocketData {
  session?: DirectSession;
}

class DirectSession {
  private readonly events = new EventTarget();
  private readonly socket: MeshRelayClientSocket;
  private stream?: MeshRelayDataStream;
  private operation?: Promise<void>;
  private finished = false;
  private readonly timeout: ReturnType<typeof setTimeout>;

  constructor(private readonly ws: ServerWebSocket<DirectSocketData>) {
    this.socket = {
      get readyState() { return ws.readyState; },
      get bufferedAmount() { return ws.getBufferedAmount(); },
      binaryType: "arraybuffer",
      send: (data) => { ws.send(data); },
      close: (code, reason) => { ws.close(code, reason); },
      addEventListener: (type, listener) => this.events.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) => this.events.removeEventListener(type, listener as EventListener),
    };
    this.timeout = setTimeout(() => ws.close(1008, "Workspace authentication timed out"), 10_000);
    this.timeout.unref?.();
  }

  message(raw: string | Buffer): void {
    if (this.stream) {
      this.stream.push(typeof raw === "string"
        ? { kind: "text", text: raw } : { kind: "binary", bytes: new Uint8Array(raw) });
      return;
    }
    if (this.operation) {
      this.ws.close(1008, "Workspace authentication is pending");
      return;
    }
    this.operation = this.serve(raw).catch((error: unknown) => {
      log[isDomainError(error) ? "warn" : "error"]("Direct workspace stream failed", {
        code: isDomainError(error) ? error.code : "collaboration_direct_failed",
      });
      this.ws.close(1008, "Direct workspace stream unavailable");
    }).finally(() => {
      clearTimeout(this.timeout);
      this.stream?.dispose();
      this.finished = true;
      if (this.ws.readyState === 3) sessions.delete(this);
    });
  }

  private async serve(raw: string | Buffer): Promise<void> {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_OPEN_BYTES) {
      throw new DomainError("collaboration_request_invalid", "A bounded workspace authentication frame is required.");
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (cause) { throw new DomainError("collaboration_request_invalid", "Invalid workspace authentication JSON.", { cause }); }
    const parsed = WorkspaceDirectOpenSchema.safeParse(value);
    if (!parsed.success) throw new DomainError("collaboration_request_invalid", "Invalid direct workspace authentication.");
    const opening = parsed.data;
    const { enrollment, ready } = await workspaceClientController.admitDirectStream(opening);
    if (this.ws.readyState !== 1) return;
    this.stream = new MeshRelayDataStream(this.socket, opening.requestId, opening.streamId, () => {}, log);
    this.stream.send(JSON.stringify(ready));
    // Enrollment is not authorized until its bounded request body is read.
    if (!enrollment) clearTimeout(this.timeout);
    if (opening.kind === "probe") {
      await this.stream.next(10_000);
      this.stream.close();
      return;
    }
    if (opening.kind === "socket") {
      await serveSocketStream(this.stream, {
        path: MESH_RELAY_CLIENT_SOCKET_PATH, headers: opening.headers,
        initiatorNodeId: opening.identity.nodeId,
      }, true, async (input) => await workspaceClientSockets.open({ ...input, directWorkspace: true }));
    } else {
      await serveMeshRelayHttpStream({
        stream: this.stream, method: "POST",
        path: enrollment ? MESH_RELAY_CLIENT_ENROLLMENT_PATH : MESH_RELAY_CLIENT_OPERATION_PATH,
        headers: opening.headers, initiatorNodeId: opening.identity.nodeId,
        secureTransport: true, transportProtocolVersion: MESH_PROTOCOL_VERSION, directWorkspace: true,
        dispatch: async (request) => enrollment
          ? await enrollWorkspaceClient(request) : await dispatchWorkspaceClient(request),
        reportStatus: () => {},
      });
    }
  }

  closed(code: number, reason: string): void {
    clearTimeout(this.timeout);
    this.stream?.push({ kind: "closed", code: fromMeshRelayCloseCode(code), reason });
    this.events.dispatchEvent(new Event("close"));
    if (!this.operation || this.finished) sessions.delete(this);
  }

  async stop(): Promise<void> {
    this.ws.close(1001, "Controller stopping");
    await Promise.all([this.operation, waitForMeshRelaySocketClosed(this.socket)]);
  }
}

// Cross-origin browser guests authenticate with signed frames, not cookies or
// owner credentials. TLS is checked before upgrade; no secrets enter the URL.
export const workspaceDirectRoutes = defineRoutes({
  [WORKSPACE_DIRECT_PATH]: {
    auth: "public", sameOrigin: "never", catalog: false,
    GET(request, ctx) {
      if (!isSecureMeshRequest(request)) {
        return Response.json({ error: "mesh_tls_required", message: "Direct workspace connections require WSS." }, { status: 403 });
      }
      if (sessions.size >= MAX_SESSIONS) {
        log.warn("Direct workspace connection capacity reached");
        return Response.json({ error: "collaboration_connection_capacity" }, { status: 429 });
      }
      return ctx.server?.upgrade(request, {
        data: { webappSocketHandler: "workspaceDirect" },
      }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
  },
});

export const workspaceDirectHandlers = {
  open(ws: ServerWebSocket<DirectSocketData>): void {
    if (sessions.size >= MAX_SESSIONS) { ws.close(1013, "Controller at capacity"); return; }
    const session = new DirectSession(ws);
    ws.data.session = session;
    sessions.add(session);
  },
  message(ws: ServerWebSocket<DirectSocketData>, raw: string | Buffer): void { ws.data.session?.message(raw); },
  close(ws: ServerWebSocket<DirectSocketData>, code: number, reason: string): void { ws.data.session?.closed(code, reason); },
};

export async function stopWorkspaceDirect(): Promise<void> {
  const results = await Promise.allSettled([...sessions].map((session) => session.stop()));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Direct workspace transport cleanup failed.");
}
