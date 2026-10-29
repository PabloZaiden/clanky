/**
 * Application grants and resource isolation, independent of credential transport.
 */
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { ControlGrantSelection } from "@/contracts/schemas/control";
import {
  findRouteCatalogEntry, resolveRouteOperation,
  type HttpMethod, type RouteCatalogEntry,
} from "@pablozaiden/webapp/server";
import {
  AGENT_PROMPT_SCOPE, CLANKY_CONTROL_SCOPE, CLANKY_CONTROL_GENERAL_SCOPE,
  CLANKY_CONTROL_MANAGED_SCOPE, controlWorkspaceScope, type ManagedContextIdentity,
} from "@/shared/context-api-key";
import { readReferenceField, isReadRecord } from "@/shared/record";
import { requireCurrentUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { getWorkspace } from "../persistence/workspaces";
import { getWorkerRegistration } from "../persistence/mesh";
import { managedCredentialService } from "./managed-credential-service";
import { collaborationService } from "./collaboration-service";
import { requireBoundWorkspaceResource } from "./workspace-operation-authority";
import type { OperationAuthority, OperationRequest, OperationResult, PreparedOperation } from "./clanky-operation-service";

export const CONTROL_RESOURCE_TAG = "clanky-control-resource";
export const CONTROL_INTERACTION_TAG = "clanky-control-interaction";
const WORKSPACE_RESOURCES = new Set(["chat", "task", "workspace", "review-comment"]);

export interface ControlGrant {
  readonly credentialId: string;
  readonly user: CurrentUser;
  readonly general: boolean;
  readonly workspaceId?: string;
  readonly managedContext?: ManagedContextIdentity;
}

export async function requireControlWorker(grant: ControlGrant, workerNodeId: string): Promise<void> {
  if (!grant.managedContext) {
    throw new DomainError("control_scope_required", "Mesh callbacks require an execution-owned control credential.");
  }
  const workspace = await getWorkspace(grant.managedContext.workspaceId);
  const registration = await getWorkerRegistration(workerNodeId, grant.user.id);
  if (workspace?.executionHostBinding.host.kind !== "mesh"
    || workspace.executionHostBinding.host.nodeId !== workerNodeId
    || registration?.grantStatus !== "active") {
    throw new DomainError("control_context_unavailable", "The control execution no longer belongs to this Mesh worker.");
  }
}

export function controlGrantScopes(selection: ControlGrantSelection): string[] {
  return [CLANKY_CONTROL_SCOPE, selection.level === "general"
    ? CLANKY_CONTROL_GENERAL_SCOPE : controlWorkspaceScope(selection.workspaceId)];
}

export async function resolveControlGrant(input: {
  credentialId: string;
  scopes: readonly string[];
  apiKeyId?: string;
}): Promise<ControlGrant> {
  const user = requireCurrentUser();
  const scopes = new Set(input.scopes);
  if (!scopes.has(CLANKY_CONTROL_SCOPE) || scopes.has("*")) {
    throw new DomainError("control_scope_required", "Use a scoped Clanky control credential.");
  }
  const managed = scopes.has(CLANKY_CONTROL_MANAGED_SCOPE);
  const identity = managed && input.apiKeyId
    ? await managedCredentialService.resolveControlContext(input.apiKeyId) : undefined;
  if (managed && !identity) {
    throw new DomainError("control_context_unavailable", "This credential is not bound to a managed execution.");
  }
  const workspaceScopes = [...scopes].filter((scope) => scope.startsWith(controlWorkspaceScope("")));
  const workspaceId = workspaceScopes[0]?.slice(controlWorkspaceScope("").length);
  const general = scopes.has(CLANKY_CONTROL_GENERAL_SCOPE);
  if (workspaceScopes.length > 1 || workspaceScopes.length > 0 && !workspaceId || !general && !workspaceId
    || identity && identity.workspaceId !== workspaceId) {
    throw new DomainError("control_scope_invalid", "A control credential must name its exact authorized workspace or general grant.");
  }
  for (const scope of scopes) {
    if ([CLANKY_CONTROL_SCOPE, CLANKY_CONTROL_GENERAL_SCOPE, CLANKY_CONTROL_MANAGED_SCOPE].includes(scope)
      || scope === controlWorkspaceScope(workspaceId ?? "")
      || managed && (scope === AGENT_PROMPT_SCOPE || scope.startsWith(`${AGENT_PROMPT_SCOPE}:`))) continue;
    throw new DomainError("control_scope_invalid", "Control credentials cannot include unrelated application scopes.");
  }
  const workspace = workspaceId ? await getWorkspace(workspaceId) : undefined;
  if (workspaceId && !workspace) {
    throw new DomainError("control_workspace_unavailable", "The authorized workspace is unavailable.");
  }
  return Object.freeze({
    credentialId: input.credentialId, user: Object.freeze({ ...user }),
    general: general && (!identity || workspace?.allowClankyContext === true),
    ...(workspaceId ? { workspaceId } : {}),
    ...(identity ? { managedContext: Object.freeze({ ...identity }) } : {}),
  });
}

export interface ControlAuthorizedOperation {
  entry: RouteCatalogEntry;
  method: HttpMethod;
  params: Readonly<Record<string, string>>;
}

type DispatchResult = Omit<OperationResult, "operationId" | "completion">;

export class ControlOperationAuthority implements OperationAuthority {
  private current: ControlGrant;
  private released = false;

  constructor(private readonly options: {
    grant: ControlGrant;
    catalog: readonly RouteCatalogEntry[];
    revalidate: () => Promise<ControlGrant>;
    dispatch: (request: OperationRequest, operation: ControlAuthorizedOperation) => Promise<DispatchResult>;
  }) {
    this.current = options.grant;
  }

  private get workspaceId(): string | undefined {
    return this.options.grant.general && this.current.general
      ? undefined : this.options.grant.workspaceId ?? this.current.workspaceId;
  }

  get general(): boolean { return this.options.grant.general && this.current.general; }

  allows = (entry: RouteCatalogEntry, method: HttpMethod): boolean => {
    if (this.released || !entry.methods.includes(method)) return false;
    for (const { user } of [this.options.grant, this.current]) {
      if (entry.auth === "admin" && !user.isAdmin || entry.auth === "owner" && !user.isOwner) return false;
    }
    const metadata = resolveRouteOperation(entry, method);
    if (!metadata.automation || metadata.automation.policy === "excluded") return false;
    if (entry.tags.includes(CONTROL_INTERACTION_TAG)) return metadata.automation.policy === "read";
    if (!entry.tags.includes(CONTROL_RESOURCE_TAG)) return false;
    if (!this.workspaceId) return this.options.grant.general && this.current.general;
    const delegation = metadata.delegation;
    return !!delegation && WORKSPACE_RESOURCES.has(delegation.resource)
      && (delegation.action === "work" || delegation.action === "scratchpad");
  };

  refresh(next: OperationAuthority): void {
    if (!(next instanceof ControlOperationAuthority) || this.released
      || next.current.credentialId !== this.options.grant.credentialId
      || next.current.user.id !== this.options.grant.user.id
      || next.options.grant.workspaceId !== this.options.grant.workspaceId) {
      next.release();
      throw new DomainError("control_authority_unavailable", "The original control authority cannot be replaced.");
    }
    this.current = next.current;
    this.options.revalidate = next.options.revalidate;
    this.options.dispatch = next.options.dispatch;
    next.release();
  }

  async validate(prepared: PreparedOperation, signal: AbortSignal): Promise<void> {
    await this.authorize({ method: prepared.method, path: prepared.path, body: prepared.body, signal });
  }

  private async authorize(request: OperationRequest): Promise<{
    operation: ControlAuthorizedOperation; workspaceId?: string; readOnly: boolean;
  }> {
    if (this.released || request.signal.aborted) {
      throw new DomainError("control_context_ended", "The control execution was cancelled.");
    }
    const current = await this.options.revalidate();
    if (current.credentialId !== this.options.grant.credentialId
      || current.user.id !== this.options.grant.user.id
      || current.workspaceId !== this.options.grant.workspaceId) {
      throw new DomainError("control_authority_unavailable", "The original control grant is no longer available.");
    }
    this.current = current;
    const url = new URL(request.path, "http://clanky.invalid");
    const match = findRouteCatalogEntry(this.options.catalog, url.pathname);
    if (!match || !this.allows(match.entry, request.method)) {
      throw new DomainError("control_operation_unavailable", "The operation is outside this control grant.");
    }
    const operation = { entry: match.entry, method: request.method, params: match.params };
    const metadata = resolveRouteOperation(match.entry, request.method);
    const readOnly = metadata.automation!.policy === "read";
    const workspaceId = this.workspaceId;
    if (!workspaceId || match.entry.tags.includes(CONTROL_INTERACTION_TAG)) {
      return { operation, readOnly };
    }
    const delegation = metadata.delegation;
    if (!delegation) {
      throw new DomainError("control_operation_unavailable", "The operation has no workspace authority contract.");
    }
    if (delegation.action === "scratchpad" && (!isReadRecord(request.body)
      || Object.keys(request.body).length !== 1 || typeof request.body["scratchpad"] !== "string")) {
      throw new DomainError("control_workspace_administration_forbidden", "Workspace control can update the scratchpad, not execution or access settings.");
    }
    for (const binding of delegation.bindings ?? []) {
      const value = binding.source === "param" ? match.params[binding.name]
        : binding.source === "query" ? url.searchParams.get(binding.name)
          : readReferenceField(request.body, binding.name);
      if (value === undefined || value === null || value === "") continue;
      if (binding.resource === "workspace-controller") {
        throw new DomainError("control_workspace_administration_forbidden", "Workspace control cannot select another controller.");
      }
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id !== "string") {
          throw new DomainError("control_reference_invalid", "An operation resource reference is invalid.");
        }
        requireBoundWorkspaceResource({
          ownerUserId: current.user.id, workspaceId, resource: binding.resource, id,
        });
      }
    }
    return { operation, workspaceId, readOnly };
  }

  async request(request: OperationRequest): Promise<DispatchResult> {
    const { operation, workspaceId, readOnly } = await this.authorize(request);
    if (request.signal.aborted) {
      throw new DomainError("control_context_ended", "The control execution was cancelled.");
    }
    if (!workspaceId) return await this.options.dispatch(request, operation);
    return await collaborationService.withWorkspaceAccess(workspaceId,
      async () => await this.options.dispatch(request, operation),
      readOnly ? "read" : "work");
  }

  release(): void {
    this.released = true;
  }
}
