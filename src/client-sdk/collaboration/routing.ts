/**
 * Canonical route-bound translation of transport references, not domain content.
 */
import {
  buildCompiledRoutePath,
  compileRoutePatterns,
  compileRouteOperations,
  matchRouteOperations,
  type HttpMethod,
  type RouteDelegationMetadata,
} from "@pablozaiden/webapp/routing";
import {
  decodeCollaborationResourceReference,
  encodeCollaborationResourceReference,
} from "@/shared/collaboration-reference";
import type { CollaborationRouteOperation } from "@/shared/collaboration-operation";
import { DomainError } from "../../domain/domain-error";
import { isReadRecord, readReferenceField } from "@/shared/record";

export interface WorkspaceSourceRequest {
  connectionId?: string;
  hasLocalReference: boolean;
  params: Record<string, string>;
  url: URL;
  body?: unknown;
}

function replaceField(value: unknown, path: string, next: unknown): void {
  const parts = path.split(".");
  const field = parts.pop()!;
  let current = value;
  for (const part of parts) {
    if (!isReadRecord(current)) return;
    current = current[part];
  }
  if (isReadRecord(current)) current[field] = next;
}

export function resolveWorkspaceSource(input: {
  params: Readonly<Record<string, string>>;
  url: URL;
  body?: unknown;
  delegation: RouteDelegationMetadata;
}): WorkspaceSourceRequest {
  const result: WorkspaceSourceRequest = {
    params: { ...input.params }, url: new URL(input.url), body: input.body,
    hasLocalReference: false,
  };
  const decode = (value: unknown, resource: string): unknown => {
    if (typeof value !== "string" || !value) return value;
    const reference = decodeCollaborationResourceReference(value);
    if (!reference) {
      if (resource !== "read-item") result.hasLocalReference = true;
      return value;
    }
    if (reference.resourceKind !== resource) {
      throw new DomainError("collaboration_reference_invalid", "The reference kind does not match this operation.");
    }
    if (result.connectionId && result.connectionId !== reference.connectionId) {
      throw new DomainError("collaboration_mixed_sources", "An operation cannot combine controllers.");
    }
    result.connectionId = reference.connectionId;
    return reference.resourceId;
  };
  for (const binding of input.delegation.bindings ?? []) {
    const value = binding.source === "param" ? result.params[binding.name]
      : binding.source === "query" ? result.url.searchParams.get(binding.name)
        : readReferenceField(result.body, binding.name);
    const next = Array.isArray(value) ? value.map((id: unknown) => decode(id, binding.resource))
      : decode(value, binding.resource);
    if (next === undefined || next === null) continue;
    if (binding.source === "param" && typeof next === "string") result.params[binding.name] = next;
    else if (binding.source === "query" && typeof next === "string") result.url.searchParams.set(binding.name, next);
    else if (binding.source === "body") replaceField(result.body, binding.name, next);
  }
  if (result.connectionId && result.hasLocalReference) {
    throw new DomainError("collaboration_mixed_sources", "An operation cannot combine local and remote resources.");
  }
  return result;
}

export function workspaceOperationPath(
  path: string,
  params: Readonly<Record<string, string>>,
  url: URL,
): string {
  const pattern = compileRoutePatterns(path, path).api;
  return buildCompiledRoutePath(pattern, pattern.captures.map((capture) => {
    const value = params[capture.name] ?? "";
    return { value, segments: value.split("/") };
  })) + url.search;
}

export function createWorkspaceUrlQualifier(operations: readonly CollaborationRouteOperation[]) {
  const compiled = compileRouteOperations(operations);
  return (connectionId: string, path: string): string => {
    if (!path.startsWith("/api/") || path.startsWith("//")) return path;
    const url = new URL(path, "https://clanky.invalid");
    const method: HttpMethod = "GET";
    const match = matchRouteOperations(compiled, url.pathname, method);
    if (match.kind !== "matched") return path;
    const metadata = match.operation.metadata.delegation;
    if (!metadata) return path;
    const params = { ...match.params };
    for (const binding of metadata.bindings ?? []) {
      if (binding.source === "body") continue;
      const value = binding.source === "param" ? params[binding.name] : url.searchParams.get(binding.name);
      if (!value) continue;
      const qualified = encodeCollaborationResourceReference({
        connectionId, resourceKind: binding.resource, resourceId: value,
      });
      if (binding.source === "param") params[binding.name] = qualified;
      else url.searchParams.set(binding.name, qualified);
    }
    return workspaceOperationPath(match.operation.path, params, url);
  };
}
