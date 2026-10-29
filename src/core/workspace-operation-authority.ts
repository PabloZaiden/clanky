/**
 * Binds canonical operation references to one granted workspace before dispatch.
 */
import type { DelegatedOperation } from "@pablozaiden/webapp/server";
import type { CollaborationGuestGrant, WorkspaceAccessAuthority } from "@/shared/collaboration";
import { DomainError } from "../domain/domain-error";
import { findResourceWorkspace, workspaceUsesExecutionHost } from "../persistence/workspace-resource-index";
import { collaborationService } from "./collaboration-service";
import { isReadRecord } from "../client-sdk/collaboration/resource-read";
import { readReferenceField } from "@/shared/record";
import { FileSystemCommandSchema } from "@/contracts/schemas/file-system";

async function readOperationBody(operation: DelegatedOperation, request: Request): Promise<unknown> {
  if (!request.body || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    || (!operation.delegation.bindings?.some((binding) => binding.source === "body")
      && operation.delegation.action !== "filesystem")) return undefined;
  try {
    return await request.clone().json();
  } catch (error) {
    throw new DomainError("collaboration_request_invalid", "A valid JSON operation body is required.", { cause: error });
  }
}

export function requireBoundWorkspaceResource(input: {
  ownerUserId: string;
  workspaceId: string;
  resource: string;
  id: string;
}): void {
  if (input.resource === "read-item") return;
  if (input.resource === "execution-host" && workspaceUsesExecutionHost({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    executionHostId: input.id,
  })) return;
  const workspaceId = findResourceWorkspace({
    resource: input.resource, id: input.id, ownerUserId: input.ownerUserId,
  });
  if (workspaceId !== input.workspaceId) {
    throw new DomainError("collaboration_resource_unavailable", "The resource is not available in this shared workspace.");
  }
}

export function requireWorkspaceResource(input: {
  guest: CollaborationGuestGrant;
  workspaceId: string;
  resource: string;
  id: string;
}): void {
  requireBoundWorkspaceResource({ ...input, ownerUserId: input.guest.ownerUserId });
  if (input.resource === "terminal" || input.resource === "preview") {
    collaborationService.authorizeInteractiveResource({
      kind: input.resource, id: input.id, workspaceId: input.workspaceId,
    });
  }
}

export async function authorizeWorkspaceOperation(input: {
  guest: CollaborationGuestGrant;
  workspaceId: string;
  operation: DelegatedOperation;
  request: Request;
}): Promise<WorkspaceAccessAuthority> {
  const { operation, request } = input;
  const bindings = operation.delegation.bindings ?? [];
  const url = new URL(request.url);
  const body = await readOperationBody(operation, request);
  const policy = operation.metadata.automation?.policy;
  let readOnly = operation.method === "GET"
    && (policy === "read" || policy === undefined || policy === "excluded");
  if (operation.method === "POST" && operation.delegation.action === "saved-message-speech") readOnly = true;
  if (operation.delegation.action === "filesystem") {
    const command = FileSystemCommandSchema.safeParse(body);
    readOnly = command.success && ["info", "stat", "list"].includes(command.data.operation);
  }
  const authority = collaborationService.requireWorkspaceAccess(input.workspaceId, readOnly ? "read" : "work");
  if (operation.delegation.action === "workspace-admin") {
    collaborationService.requireWorkspaceAccess(input.workspaceId, "admin");
  }
  if (operation.delegation.action === "scratchpad") {
    if (isReadRecord(body) && Object.keys(body).some((field) => field !== "scratchpad")) {
      collaborationService.requireWorkspaceAccess(input.workspaceId, "admin");
    }
    if ((!isReadRecord(body) || typeof body["scratchpad"] !== "string") && !authority.capabilities.includes("admin")) {
      throw new DomainError("collaboration_request_invalid", "A scratchpad update is required.");
    }
  }
  for (const binding of bindings) {
    if (binding.resource === "workspace-controller") continue;
    const value = binding.source === "param" ? operation.params[binding.name]
      : binding.source === "query" ? url.searchParams.get(binding.name)
        : readReferenceField(body, binding.name);
    if (value === undefined || value === null || value === "") continue;
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const id of values) {
      if (typeof id !== "string") {
        throw new DomainError("collaboration_reference_invalid", "An operation resource reference is invalid.");
      }
      requireWorkspaceResource({
        guest: input.guest, workspaceId: input.workspaceId,
        resource: binding.resource, id,
      });
    }
  }
  return authority;
}

export async function resolveOperationWorkspaces(input: {
  guest: CollaborationGuestGrant;
  operation: DelegatedOperation;
  request: Request;
  workspaceId?: string;
}): Promise<string[]> {
  const workspaceIds = new Set<string>();
  if (input.workspaceId) workspaceIds.add(input.workspaceId);
  const bindings = input.operation.delegation.bindings ?? [];
  const url = new URL(input.request.url);
  const body = await readOperationBody(input.operation, input.request);
  for (const binding of bindings) {
    if (binding.resource === "workspace-controller") {
      const controllerId = url.searchParams.get(binding.name);
      if (controllerId && controllerId !== input.guest.ownerUserId) {
        throw new DomainError("collaboration_access_denied", "The workspace controller is unavailable.");
      }
      continue;
    }
    if (binding.resource === "read-item" || binding.resource === "execution-host") continue;
    const value = binding.source === "param" ? input.operation.params[binding.name]
      : binding.source === "query" ? url.searchParams.get(binding.name)
        : readReferenceField(body, binding.name);
    if (value === undefined || value === null || value === "") continue;
    for (const id of Array.isArray(value) ? value : [value]) {
      if (typeof id !== "string") {
        throw new DomainError("collaboration_reference_invalid", "An operation resource reference is invalid.");
      }
      const workspaceId = findResourceWorkspace({
        resource: binding.resource, id, ownerUserId: input.guest.ownerUserId,
      });
      if (!workspaceId) {
        throw new DomainError("collaboration_resource_unavailable", "The resource is unavailable.");
      }
      workspaceIds.add(workspaceId);
    }
  }
  if (workspaceIds.size > 1) {
    throw new DomainError("collaboration_workspace_mismatch", "An operation cannot combine resources from different workspaces.");
  }
  if (workspaceIds.size) return [...workspaceIds];
  if (["controller-access", "workspace-create", "workspace-targets", "workspace-test"].includes(input.operation.delegation.action)) {
    return [];
  }
  if (input.operation.method === "GET" && input.operation.delegation.collection) {
    return input.guest.workspaceIds;
  }
  throw new DomainError("collaboration_authority_required", "The operation must identify a shared workspace.");
}
