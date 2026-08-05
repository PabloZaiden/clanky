/**
 * Mesh endpoint and transport policy.
 *
 * Mesh endpoints may use HTTP or HTTPS. HTTP is intended for trusted private
 * networks, while HTTPS remains available for deployments that need transport
 * confidentiality.
 */

import { DomainError } from "./domain-error";
import type { MeshTransport } from "@/shared/mesh";

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
  return parsed;
}

export function getMeshTransport(endpoint: string): MeshTransport {
  const parsed = assertMeshEndpointAllowed(endpoint);
  return parsed.protocol === "https:" ? "https" : "http";
}

export function resolveAdvertisedMeshEndpoint(): string {
  const configured = process.env["CLANKY_PUBLIC_BASE_URL"]?.trim();
  if (!configured) {
    throw new DomainError(
      "mesh_endpoint_not_configured",
      "CLANKY_PUBLIC_BASE_URL must be configured before using mesh pairing.",
    );
  }
  const parsed = assertMeshEndpointAllowed(configured);
  return parsed.toString().replace(/\/$/, "");
}

export function resolveMeshRoute(endpoint: string, route: string): string {
  const base = assertMeshEndpointAllowed(endpoint);
  const baseUrl = new URL(base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`);
  return new URL(route.replace(/^\/+/, ""), baseUrl).toString();
}
