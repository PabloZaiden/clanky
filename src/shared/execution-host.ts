/**
 * Transport-neutral execution host contracts.
 */

import type { ModelConfig } from "./model";
import {
  DEFAULT_EXECUTION_AGENT_PROVIDER,
  isAgentProvider,
  type AgentProvider,
} from "./settings";

export interface ExecutionHostModelConfig extends ModelConfig {
  providerID: AgentProvider;
}

export const EXECUTION_HOST_KINDS = ["local", "mesh", "ssh"] as const;
export type ExecutionHostKind = typeof EXECUTION_HOST_KINDS[number];

export const WORKSPACE_SSH_TARGET_SOURCE_PREFIX = "workspace-target:";
const SCOPED_MESH_SOURCE_PREFIX = "mesh-scoped:";

export type ExecutionHostRef =
  | { kind: "local"; nodeId: string }
  | { kind: "mesh"; nodeId: string }
  | {
      kind: "mesh";
      scope: "enrollment";
      enrollmentId: string;
      nodeId: string;
    }
  | {
      kind: "mesh";
      scope: "workspace";
      workspaceId: string;
      nodeId: string;
    }
  | { kind: "ssh"; serverId: string; scope?: "server" }
  | { kind: "ssh"; scope: "workspace"; workspaceId: string };

export const EXECUTION_HOST_CAPABILITY_IDS = [
  "commandExecution",
  "fileOperations",
  "acpRuntime",
  "interactiveTerminal",
  "provisioning",
  "devboxLifecycle",
  "tcpTunnel",
  "serverHealth",
] as const;
export type ExecutionHostCapabilityId = typeof EXECUTION_HOST_CAPABILITY_IDS[number];

/**
 * Capability values are protocol versions. Missing capabilities are not
 * supported; clients must not infer support from the host transport.
 */
export type ExecutionHostCapabilities = Partial<
  Record<ExecutionHostCapabilityId, number>
>;

export interface ExecutionNodeConfiguration {
  name: string;
  endpoint: string | null;
  repositoriesBasePath: string | null;
  preferredModel: ExecutionHostModelConfig | null;
  acceptRemoteExecution: boolean;
  capabilities: ExecutionHostCapabilities;
  revision: number;
}

export const DEFAULT_EXECUTION_HOST_CAPABILITIES: ExecutionHostCapabilities = {
  commandExecution: 1,
  fileOperations: 1,
  acpRuntime: 1,
  interactiveTerminal: 1,
  provisioning: 1,
  devboxLifecycle: 1,
  tcpTunnel: 1,
  serverHealth: 1,
};

export function createDefaultExecutionNodeConfiguration(
  name: string,
  endpoint: string | null,
): ExecutionNodeConfiguration {
  return {
    name,
    endpoint,
    repositoriesBasePath: null,
    preferredModel: null,
    acceptRemoteExecution: true,
    capabilities: { ...DEFAULT_EXECUTION_HOST_CAPABILITIES },
    revision: 1,
  };
}

export type ExecutionHostAccessRequirement =
  | { kind: "none" }
  | {
      kind: "sshCredentials";
      serverId: string;
      methods: Array<"agent" | "password">;
    };

export interface ExecutionHostBinding {
  host: ExecutionHostRef;
  targetKey: string;
  revision: number;
}

export function isWorkspaceSshExecutionHostRef(
  ref: ExecutionHostRef,
): ref is Extract<ExecutionHostRef, { kind: "ssh"; scope: "workspace" }> {
  return ref.kind === "ssh" && ref.scope === "workspace";
}

export function isEnrollmentMeshExecutionHostRef(
  ref: ExecutionHostRef,
): ref is Extract<ExecutionHostRef, { kind: "mesh"; scope: "enrollment" }> {
  return ref.kind === "mesh"
    && "scope" in ref
    && ref.scope === "enrollment";
}

export function isWorkspaceMeshExecutionHostRef(
  ref: ExecutionHostRef,
): ref is Extract<ExecutionHostRef, { kind: "mesh"; scope: "workspace" }> {
  return ref.kind === "mesh"
    && "scope" in ref
    && ref.scope === "workspace";
}

export function isPrivateMeshExecutionHostRef(
  ref: ExecutionHostRef,
): ref is Extract<ExecutionHostRef, { kind: "mesh"; scope: "enrollment" | "workspace" }> {
  return isEnrollmentMeshExecutionHostRef(ref) || isWorkspaceMeshExecutionHostRef(ref);
}

export function getRegisteredSshServerId(
  ref: ExecutionHostRef,
): string | null {
  if (ref.kind !== "ssh" || isWorkspaceSshExecutionHostRef(ref)) {
    return null;
  }
  return ref.serverId;
}

export interface ExecutionHostDescriptor {
  ref: ExecutionHostRef;
  targetKey: string;
  name: string;
  endpoint: string | null;
  repositoriesBasePath: string | null;
  preferredModel: ExecutionHostModelConfig | null;
  configurationRevision: number;
  accessRequirement: ExecutionHostAccessRequirement;
  acceptRemoteExecution: boolean;
  capabilities: ExecutionHostCapabilities;
  revision: number;
  isPrivate?: boolean;
}

export function getExecutionHostDefaultDirectory(
  host: Pick<ExecutionHostDescriptor, "repositoriesBasePath">,
): string {
  return host.repositoriesBasePath?.trim() || ".";
}

export function getExecutionHostAgentProvider(
  host: Pick<ExecutionHostDescriptor, "preferredModel">,
): AgentProvider {
  const provider = host.preferredModel?.providerID;
  return isAgentProvider(provider)
    ? provider
    : DEFAULT_EXECUTION_AGENT_PROVIDER;
}

export function getExecutionHostSourceId(ref: ExecutionHostRef): string {
  if (isEnrollmentMeshExecutionHostRef(ref)) {
    return `${SCOPED_MESH_SOURCE_PREFIX}${encodeURIComponent(JSON.stringify({
      scope: ref.scope,
      enrollmentId: ref.enrollmentId,
      nodeId: ref.nodeId,
    }))}`;
  }
  if (isWorkspaceMeshExecutionHostRef(ref)) {
    return `${SCOPED_MESH_SOURCE_PREFIX}${encodeURIComponent(JSON.stringify({
      scope: ref.scope,
      workspaceId: ref.workspaceId,
      nodeId: ref.nodeId,
    }))}`;
  }
  if (ref.kind === "ssh") {
    return isWorkspaceSshExecutionHostRef(ref)
      ? `${WORKSPACE_SSH_TARGET_SOURCE_PREFIX}${ref.workspaceId}`
      : ref.serverId;
  }
  return ref.nodeId;
}

export function executionHostRefFromParts(
  kind: string,
  sourceId: string,
): ExecutionHostRef | null {
  if (kind === "local") {
    return { kind, nodeId: sourceId };
  }
  if (kind === "mesh") {
    if (!sourceId.startsWith(SCOPED_MESH_SOURCE_PREFIX)) {
      return { kind, nodeId: sourceId };
    }
    try {
      const value = JSON.parse(
        decodeURIComponent(sourceId.slice(SCOPED_MESH_SOURCE_PREFIX.length)),
      ) as Record<string, unknown>;
      if (value["scope"] === "enrollment"
        && typeof value["enrollmentId"] === "string"
        && typeof value["nodeId"] === "string"
        && value["enrollmentId"].trim()
        && value["nodeId"].trim()) {
        return {
          kind,
          scope: "enrollment",
          enrollmentId: value["enrollmentId"],
          nodeId: value["nodeId"],
        };
      }
      if (value["scope"] === "workspace"
        && typeof value["workspaceId"] === "string"
        && typeof value["nodeId"] === "string"
        && value["workspaceId"].trim()
        && value["nodeId"].trim()) {
        return {
          kind,
          scope: "workspace",
          workspaceId: value["workspaceId"],
          nodeId: value["nodeId"],
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (kind === "ssh") {
    if (sourceId.startsWith(WORKSPACE_SSH_TARGET_SOURCE_PREFIX)) {
      const workspaceId = sourceId.slice(WORKSPACE_SSH_TARGET_SOURCE_PREFIX.length).trim();
      return workspaceId
        ? { kind: "ssh", scope: "workspace", workspaceId }
        : null;
    }
    return { kind, serverId: sourceId };
  }
  return null;
}

export function serializeExecutionHostRef(ref: ExecutionHostRef): string {
  return `${ref.kind}:${encodeURIComponent(getExecutionHostSourceId(ref))}`;
}

export function parseExecutionHostRef(value: string): ExecutionHostRef {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error("Invalid execution host reference");
  }

  const kind = value.slice(0, separatorIndex);
  let sourceId: string;
  try {
    sourceId = decodeURIComponent(value.slice(separatorIndex + 1)).trim();
  } catch (error) {
    throw new Error("Invalid execution host reference", { cause: error });
  }
  if (!sourceId) {
    throw new Error("Invalid execution host reference");
  }

  const ref = executionHostRefFromParts(kind, sourceId);
  if (!ref) {
    throw new Error("Invalid execution host reference");
  }
  return ref;
}

export function executionHostRefsEqual(
  left: ExecutionHostRef,
  right: ExecutionHostRef,
): boolean {
  return serializeExecutionHostRef(left) === serializeExecutionHostRef(right);
}

export function executionHostBindingsEqual(
  left: ExecutionHostBinding,
  right: ExecutionHostBinding,
): boolean {
  return executionHostRefsEqual(left.host, right.host)
    && left.targetKey === right.targetKey
    && left.revision === right.revision;
}

export function supportsExecutionHostCapability(
  capabilities: ExecutionHostCapabilities,
  capability: ExecutionHostCapabilityId,
  minimumVersion: number = 1,
): boolean {
  return (capabilities[capability] ?? 0) >= minimumVersion;
}
