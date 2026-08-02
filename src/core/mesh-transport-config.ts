/**
 * Mesh endpoint and transport policy.
 *
 * Insecure HTTP is intentionally limited to loopback use. HTTPS does not
 * require a publicly trusted certificate.
 */

import { DomainError } from "./domain-error";
import type { MeshTransport } from "@/shared/mesh";

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

export function assertMeshEndpointAllowed(
  endpoint: string,
  expectedTransport?: MeshTransport,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw new DomainError("mesh_endpoint_invalid", "Mesh endpoint is not a valid URL.", { cause: error });
  }
  const transport: MeshTransport | undefined = parsed.protocol === "https:"
    ? "https"
    : parsed.protocol === "http:"
      ? "http"
      : undefined;
  if (!transport) {
    throw new DomainError("mesh_endpoint_protocol_invalid", "Mesh endpoint must use http or https.");
  }
  if (expectedTransport && expectedTransport !== transport) {
    throw new DomainError("mesh_endpoint_transport_mismatch", "Mesh endpoint protocol does not match its transport.");
  }
  if (parsed.search || parsed.hash) {
    throw new DomainError("mesh_endpoint_invalid", "Mesh endpoint must not contain a query or fragment.");
  }
  if (transport === "http" && !isLoopbackHost(parsed.hostname)) {
    throw new DomainError(
      "mesh_insecure_transport_not_loopback",
      "Insecure mesh HTTP is only allowed for loopback endpoints.",
    );
  }
  return parsed;
}

export function getMeshTransport(endpoint: string): MeshTransport {
  const parsed = assertMeshEndpointAllowed(endpoint);
  return parsed.protocol === "https:" ? "https" : "http";
}

export function resolveAdvertisedMeshEndpoint(requestUrl: string): string {
  const configured = process.env["CLANKY_MESH_ENDPOINT"]?.trim();
  const endpoint = configured && configured.length > 0
    ? configured
    : new URL(requestUrl).origin;
  const parsed = assertMeshEndpointAllowed(endpoint);
  return parsed.toString().replace(/\/$/, "");
}

export function resolveMeshRoute(endpoint: string, route: string): string {
  const base = assertMeshEndpointAllowed(endpoint);
  const baseUrl = new URL(base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`);
  return new URL(route.replace(/^\/+/, ""), baseUrl).toString();
}
