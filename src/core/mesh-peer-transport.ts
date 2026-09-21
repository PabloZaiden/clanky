import type { MeshPeerRoute } from "@/shared/mesh";
import { assertMeshWorkerTlsCertificate } from "../persistence/mesh-worker-tls";
import { DomainError } from "../domain/domain-error";
import { resolveMeshRoute } from "./mesh-transport-config";

export interface MeshPeerRequest {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface MeshSocketEventMap {
  close: CloseEvent;
  error: Event;
  message: MessageEvent;
  open: Event;
}

export interface MeshDuplexSocket extends EventTarget {
  binaryType: BinaryType;
  readonly readyState: number;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => void) | null;
  addEventListener<K extends keyof MeshSocketEventMap>(
    type: K,
    listener: (event: MeshSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof MeshSocketEventMap>(
    type: K,
    listener: (event: MeshSocketEventMap[K]) => void,
  ): void;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface MeshPeerTransport {
  request(
    route: MeshPeerRoute,
    path: string,
    request: MeshPeerRequest,
  ): Promise<Response>;
  openSocket(
    route: MeshPeerRoute,
    path: string,
    headers: Record<string, string>,
  ): MeshDuplexSocket;
}

function directTlsOptions(
  route: Extract<MeshPeerRoute, { kind: "direct" }>,
): Bun.TLSOptions | undefined {
  if (route.transport === "http") {
    if (
      route.tlsTrust !== "none"
      || route.tlsCertificate
      || route.tlsFingerprint
    ) {
      throw new DomainError(
        "mesh_worker_tls_identity_unexpected",
        "The HTTP Mesh route must not contain TLS trust material.",
      );
    }
    return undefined;
  }
  if (route.tlsTrust === "system") {
    if (route.tlsCertificate || route.tlsFingerprint) {
      throw new DomainError(
        "mesh_worker_tls_identity_unexpected",
        "The system-PKI Mesh route must not contain pinned TLS trust material.",
      );
    }
    return undefined;
  }
  if (
    route.tlsTrust !== "pinned"
    || !route.tlsCertificate
    || !route.tlsFingerprint
  ) {
    throw new DomainError(
      "mesh_worker_tls_identity_missing",
      "The pinned HTTPS Mesh route has no complete trusted TLS identity.",
    );
  }
  assertMeshWorkerTlsCertificate(
    route.tlsCertificate,
    route.endpoint,
    route.tlsFingerprint,
  );
  return {
    ca: route.tlsCertificate,
    rejectUnauthorized: true,
  };
}

const directTransport: MeshPeerTransport = {
  request(route, path, request): Promise<Response> {
    if (route.kind !== "direct") {
      throw new DomainError(
        "mesh_transport_route_invalid",
        "The direct Mesh transport requires a direct route.",
      );
    }
    const { fetch: fetchImpl = globalThis.fetch, ...init } = request;
    return fetchImpl(resolveMeshRoute(route.endpoint, path), {
      ...init,
      tls: directTlsOptions(route),
    });
  },

  openSocket(route, path, headers): MeshDuplexSocket {
    if (route.kind !== "direct") {
      throw new DomainError(
        "mesh_transport_route_invalid",
        "The direct Mesh transport requires a direct route.",
      );
    }
    const url = resolveMeshRoute(route.endpoint, path).replace(/^http/, "ws");
    const BunWebSocket = WebSocket as unknown as {
      new (
        socketUrl: string,
        options: { headers: Record<string, string>; tls?: Bun.TLSOptions },
      ): WebSocket;
    };
    return new BunWebSocket(url, {
      headers,
      tls: directTlsOptions(route),
    });
  },
};

let relayTransport: MeshPeerTransport | null = null;

export function setMeshRelayTransport(transport: MeshPeerTransport | null): void {
  relayTransport = transport;
}

export function getMeshPeerTransport(route: MeshPeerRoute): MeshPeerTransport {
  if (route.kind === "direct") {
    return directTransport;
  }
  if (!relayTransport) {
    throw new DomainError(
      "mesh_relay_unavailable",
      "The Mesh relay transport is not connected.",
    );
  }
  return relayTransport;
}

export function requestMeshPeer(
  route: MeshPeerRoute,
  path: string,
  request: MeshPeerRequest,
): Promise<Response> {
  return getMeshPeerTransport(route).request(route, path, request);
}

export function openMeshPeerSocket(
  route: MeshPeerRoute,
  path: string,
  headers: Record<string, string>,
): MeshDuplexSocket {
  return getMeshPeerTransport(route).openSocket(route, path, headers);
}
