import { isMeshOutboundRoute, type MeshPeerRoute } from "@/shared/mesh";
import { assertSelfSignedTlsCertificate } from "../lib/tls-certificate";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { meshTargetTlsTrust } from "./mesh-tls-trust";
import { DomainError } from "../domain/domain-error";
import { resolveMeshRoute } from "./mesh-transport-config";
import { assertMeshTransportSecurity } from "./mesh-transport-security";
import { isMeshRelayResponseInterrupted, MeshRelayStreamError } from "./mesh-relay-errors";

export function describeMeshTransportFailure(error: unknown): string {
  if (error instanceof MeshRelayStreamError) {
    if (isMeshRelayResponseInterrupted(error)) return `Mesh stream interrupted (${error.code}).`;
    if (error.status === 503) return "The Mesh route is temporarily unavailable.";
    return "The Mesh transport could not complete the exchange.";
  }
  if (error instanceof Error && "code" in error && [
    "ConnectionRefused", "ConnectionClosed", "ECONNREFUSED", "ECONNRESET",
    "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ].includes(String(error.code))) {
    return `Transport error: ${String(error.code)}.`;
  }
  return "The transport failed before the response completed.";
}

function assertMeshPeerTransport(route: MeshPeerRoute): void {
  assertMeshTransportSecurity(7, new URL(route.kind === "direct" ? route.endpoint : route.relayUrl).protocol === "https:");
}

export interface MeshPeerRequest {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onDispatch?: () => void;
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

export function getMeshDirectTlsOptions(
  route: Extract<MeshPeerRoute, { kind: "direct" }>,
): (Bun.TLSOptions & Pick<ConnectionOptions, "checkServerIdentity">) | undefined {
  if (route.transport === "http") {
    throw new DomainError("mesh_tls_required", "Mesh peer routes require HTTPS.");
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
  try {
    assertSelfSignedTlsCertificate(route.tlsCertificate, new URL(route.endpoint).hostname, route.tlsFingerprint);
  } catch (error) {
    throw new DomainError("mesh_peer_tls_certificate_invalid", "The trusted Mesh certificate is invalid, expired or does not match its endpoint.", { cause: error });
  }
  return {
    ca: route.tlsCertificate,
    rejectUnauthorized: true,
    checkServerIdentity: (hostname, certificate) => checkServerIdentity(
      hostname.replace(/^\[|\]$/g, ""), certificate,
    ),
  };
}

export function openMeshDirectSocket(
  route: Extract<MeshPeerRoute, { kind: "direct" }>,
  url: string,
  headers: Record<string, string> = {},
): WebSocket {
  if (new URL(url).origin !== new URL(route.endpoint).origin.replace(/^https:/, "wss:")) {
    throw new DomainError("mesh_transport_route_invalid", "The socket target does not match its trusted Mesh route.");
  }
  const BunWebSocket = WebSocket as unknown as {
    new (
      socketUrl: string,
      options: { headers: Record<string, string>; tls?: Bun.TLSOptions },
    ): WebSocket;
  };
  return new BunWebSocket(url, { headers, tls: getMeshDirectTlsOptions(route) });
}

export function createMeshTlsFetch(target: string, certificate?: string): typeof fetch {
  const endpoint = new URL(target).origin;
  const tls = getMeshDirectTlsOptions({
    kind: "direct", endpoint, transport: "https",
    ...meshTargetTlsTrust(endpoint, certificate),
  });
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== endpoint) throw new DomainError("mesh_transport_route_invalid", "Discovery must use its trusted target origin.");
    return fetch(input, { ...init, tls, redirect: "error" });
  }, { preconnect: fetch.preconnect });
}

const directTransport: MeshPeerTransport = {
  request(route, path, request): Promise<Response> {
    if (route.kind !== "direct") {
      throw new DomainError(
        "mesh_transport_route_invalid",
        "The direct Mesh transport requires a direct route.",
      );
    }
    const { fetch: fetchImpl = globalThis.fetch, onDispatch, ...init } = request;
    const url = resolveMeshRoute(route.endpoint, path);
    const tls = getMeshDirectTlsOptions(route);
    onDispatch?.();
    return fetchImpl(url, {
      ...init,
      redirect: "error",
      tls,
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
    return openMeshDirectSocket(route, url, headers);
  },
};

let relayTransport: MeshPeerTransport | null = null;
let outboundTransport: MeshPeerTransport | null = null;

export function setMeshOutboundTransport(transport: MeshPeerTransport | null): void {
  outboundTransport = transport;
}

export function setMeshRelayTransport(transport: MeshPeerTransport | null): void {
  relayTransport = transport;
}

export function getMeshPeerTransport(route: MeshPeerRoute): MeshPeerTransport {
  if (isMeshOutboundRoute(route)) {
    if (!outboundTransport) {
      throw new DomainError(
        "mesh_worker_connection_unavailable",
        "The worker's outbound Mesh connection is not available.",
      );
    }
    return outboundTransport;
  }
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
  assertMeshPeerTransport(route);
  return getMeshPeerTransport(route).request(route, path, request);
}

export function openMeshPeerSocket(
  route: MeshPeerRoute,
  path: string,
  headers: Record<string, string>,
): MeshDuplexSocket {
  assertMeshPeerTransport(route);
  return getMeshPeerTransport(route).openSocket(route, path, headers);
}
