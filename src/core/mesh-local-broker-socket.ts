import { utf8ByteLength } from "@/shared/encoding";
import { MESH_RELAY_CONTROL_PATH, MESH_RELAY_STREAM_PATH } from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { DomainError } from "../domain/domain-error";
import type { MeshRelayBroker, MeshRelaySocket } from "./mesh-relay-broker";
import type { MeshRelayClientSocketFactory } from "./mesh-relay-client-socket";
import { MESH_RELAY_MAX_QUEUED_BYTES } from "./mesh-relay-policy";

// The controller is an in-process broker participant, never a network callback
// to its own public endpoint. Workers still authenticate over real WSS.
export function createMeshLocalBrokerSocketFactory(broker: MeshRelayBroker): MeshRelayClientSocketFactory {
  return (url) => {
    const socket = new LocalBrokerSocket(broker, new URL(url));
    return {
      get readyState() { return socket.readyState; },
      get bufferedAmount() { return socket.bufferedAmount; },
      get binaryType() { return socket.binaryType; },
      set binaryType(value) { socket.binaryType = value; },
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.terminate(),
      addEventListener: (type, listener) => socket.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) => socket.removeEventListener(type, listener as EventListener),
    };
  };
}

class LocalBrokerSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  private connectionId?: string;
  private reservationId?: string;
  private queuedBytes = 0;

  constructor(private readonly broker: MeshRelayBroker, url: URL) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
      const socket: MeshRelaySocket = {
        send: (data) => {
          if (this.readyState !== 1) return 0;
          const size = typeof data === "string" ? utf8ByteLength(data) : data.byteLength;
          if (this.queuedBytes + size > MESH_RELAY_MAX_QUEUED_BYTES) {
            this.close(1013, "Local Mesh stream capacity exceeded");
            return 0;
          }
          const copy = typeof data === "string" ? data : new Uint8Array(data);
          this.queuedBytes += size;
          queueMicrotask(() => {
            this.queuedBytes -= size;
            if (this.readyState === 1) {
              this.dispatchEvent(new MessageEvent("message", { data: copy }));
            }
          });
          return size;
        },
        close: (code, reason) => queueMicrotask(() => this.close(code, reason)),
        getBufferedAmount: () => this.queuedBytes,
      };
      try {
        if (url.pathname === MESH_RELAY_CONTROL_PATH) {
          this.connectionId = broker.openControl(socket, MESH_PROTOCOL_VERSION);
        } else if (url.pathname === MESH_RELAY_STREAM_PATH) {
          const reservation = broker.reserveDataSocket(
            url.searchParams.get("ticket") ?? "",
            url.searchParams.get("credential") ?? "",
          );
          if (!reservation) throw new DomainError("mesh_stream_ticket_invalid", "The local Mesh stream ticket is invalid.");
          this.reservationId = reservation.reservationId;
          broker.attachDataSocket(this.reservationId, socket);
        } else {
          throw new DomainError("mesh_transport_route_invalid", "The local Mesh broker route is invalid.");
        }
      } catch (error) {
        this.dispatchEvent(new ErrorEvent("error", { error }));
        this.close(1011, "Local Mesh connection unavailable");
      }
    });
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.readyState !== 1) throw new DomainError("mesh_worker_connection_unavailable", "The local Mesh connection is closed.");
    if (this.connectionId) this.broker.handleControlMessage(this.connectionId, data);
    else if (this.reservationId) this.broker.handleDataMessage(this.reservationId, data);
    else throw new DomainError("mesh_worker_connection_unavailable", "The local Mesh connection is not ready.");
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.connectionId) this.broker.handleControlClose(this.connectionId, code);
    if (this.reservationId) this.broker.closeData(this.reservationId, code, reason);
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  terminate(): void {
    this.close(1001, "Local Mesh transport terminated");
  }
}
