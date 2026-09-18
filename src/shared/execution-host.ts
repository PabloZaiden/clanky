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

export const EXECUTION_HOST_OPERATING_SYSTEMS = [
  "linux",
  "darwin",
  "windows",
] as const;
export type ExecutionHostOperatingSystem =
  typeof EXECUTION_HOST_OPERATING_SYSTEMS[number];

export const EXECUTION_HOST_ARCHITECTURES = ["x64", "arm64"] as const;
export type ExecutionHostArchitecture =
  typeof EXECUTION_HOST_ARCHITECTURES[number];

export interface ExecutionHostPlatform {
  os: ExecutionHostOperatingSystem;
  architecture: ExecutionHostArchitecture;
}

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
  "git",
  "managedWorktrees",
  "acpRuntime",
  "interactiveTerminal",
  "provisioning",
  "devboxLifecycle",
  "tcpTunnel",
  "vnc",
  "serverHealth",
] as const;
export type ExecutionHostCapabilityId = typeof EXECUTION_HOST_CAPABILITY_IDS[number];

export const GIT_COMMAND_SCOPES = [
  "repository",
  "managedWorktrees",
] as const;
export type GitCommandScope = typeof GIT_COMMAND_SCOPES[number];
export type GitEnvironmentVariableName = "GIT_SSH_COMMAND";

export const EXECUTION_HOST_CAPABILITY_VERSIONS = {
  commandExecution: 1,
  fileOperations: 2,
  git: 2,
  managedWorktrees: 2,
  acpRuntime: 2,
  interactiveTerminal: 1,
  provisioning: 1,
  devboxLifecycle: 1,
  tcpTunnel: 1,
  vnc: 1,
  serverHealth: 1,
} as const satisfies Record<ExecutionHostCapabilityId, number>;

export const WORKSPACE_EXECUTION_HOST_CAPABILITIES = [
  "fileOperations",
  "acpRuntime",
] as const satisfies readonly ExecutionHostCapabilityId[];

/**
 * Capability values are protocol versions. Missing capabilities are not
 * supported; clients must not infer support from the host transport.
 */
export type ExecutionHostCapabilities = Partial<
  Record<ExecutionHostCapabilityId, number>
>;

export interface ExecutionHostRuntimeSnapshot {
  platform: ExecutionHostPlatform | null;
  capabilities: ExecutionHostCapabilities;
}

export function parseExecutionHostCapabilities(
  value: unknown,
): ExecutionHostCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const capabilities: ExecutionHostCapabilities = {};
  for (const capability of EXECUTION_HOST_CAPABILITY_IDS) {
    const version = record[capability];
    if (version === undefined) {
      continue;
    }
    if (
      typeof version !== "number"
      || !Number.isInteger(version)
      || version < 1
    ) {
      return null;
    }
    capabilities[capability] = version;
  }
  return capabilities;
}

export interface ExecutionNodeConfiguration {
  name: string;
  endpoint: string | null;
  repositoriesBasePath: string | null;
  preferredModel: ExecutionHostModelConfig | null;
  acceptRemoteExecution: boolean;
  capabilities: ExecutionHostCapabilities;
  revision: number;
}

export const POSIX_EXECUTION_HOST_CAPABILITIES: ExecutionHostCapabilities = {
  commandExecution: 1,
  fileOperations: 2,
  git: 2,
  managedWorktrees: 2,
  acpRuntime: 2,
  interactiveTerminal: 1,
  provisioning: 1,
  devboxLifecycle: 1,
  tcpTunnel: 1,
  vnc: 1,
  serverHealth: 1,
};

export const WINDOWS_EXECUTION_HOST_CAPABILITIES: ExecutionHostCapabilities = {
  commandExecution: 1,
  fileOperations: 2,
  git: 2,
  managedWorktrees: 2,
  acpRuntime: 2,
  interactiveTerminal: 1,
  tcpTunnel: 1,
  vnc: 1,
  serverHealth: 1,
};

export function normalizeExecutionHostPlatform(
  platform: string,
  architecture: string,
): ExecutionHostPlatform | null {
  const os = platform === "win32" ? "windows" : platform;
  if (
    !EXECUTION_HOST_OPERATING_SYSTEMS.includes(
      os as ExecutionHostOperatingSystem,
    )
    || !EXECUTION_HOST_ARCHITECTURES.includes(
      architecture as ExecutionHostArchitecture,
    )
  ) {
    return null;
  }
  return {
    os: os as ExecutionHostOperatingSystem,
    architecture: architecture as ExecutionHostArchitecture,
  };
}

export function getExecutionHostCapabilitiesForPlatform(
  platform: ExecutionHostPlatform | null,
): ExecutionHostCapabilities {
  if (!platform) {
    return {};
  }
  return platform.os === "windows"
    ? { ...WINDOWS_EXECUTION_HOST_CAPABILITIES }
    : { ...POSIX_EXECUTION_HOST_CAPABILITIES };
}

export function createExecutionHostRuntimeSnapshot(
  platform: string,
  architecture: string,
): ExecutionHostRuntimeSnapshot {
  const normalizedPlatform = normalizeExecutionHostPlatform(
    platform,
    architecture,
  );
  return {
    platform: normalizedPlatform,
    capabilities: getExecutionHostCapabilitiesForPlatform(normalizedPlatform),
  };
}

export function parseExecutionHostRuntimeSnapshot(
  platform: {
    os: string | null;
    architecture: string | null;
  },
  capabilities: unknown,
): ExecutionHostRuntimeSnapshot | null {
  if ((platform.os === null) !== (platform.architecture === null)) {
    return null;
  }
  const normalizedPlatform = platform.os === null
    ? null
    : normalizeExecutionHostPlatform(platform.os, platform.architecture!);
  if (platform.os !== null && !normalizedPlatform) {
    return null;
  }
  const parsedCapabilities = parseExecutionHostCapabilities(capabilities);
  if (!parsedCapabilities) {
    return null;
  }
  return {
    platform: normalizedPlatform,
    capabilities: parsedCapabilities,
  };
}

export function createDefaultExecutionNodeConfiguration(
  name: string,
  endpoint: string | null,
  capabilities: ExecutionHostCapabilities,
): ExecutionNodeConfiguration {
  return {
    name,
    endpoint,
    repositoriesBasePath: null,
    preferredModel: null,
    acceptRemoteExecution: true,
    capabilities: { ...capabilities },
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
  meshRouteKind: "direct" | "relay" | null;
  repositoriesBasePath: string | null;
  preferredModel: ExecutionHostModelConfig | null;
  configurationRevision: number;
  accessRequirement: ExecutionHostAccessRequirement;
  acceptRemoteExecution: boolean;
  platform: ExecutionHostPlatform | null;
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
  minimumVersion: number = EXECUTION_HOST_CAPABILITY_VERSIONS[capability],
): boolean {
  return (capabilities[capability] ?? 0) >= minimumVersion;
}

export function supportsGitCommandScope(
  capabilities: ExecutionHostCapabilities,
  scope: GitCommandScope,
): boolean {
  return getUnavailableGitCommandCapability(capabilities, scope) === null;
}

export function supportsAcpRuntime(
  capabilities: ExecutionHostCapabilities,
): boolean {
  return supportsExecutionHostCapability(capabilities, "acpRuntime", 1);
}

export function supportsPortableAcpRuntime(
  capabilities: ExecutionHostCapabilities,
): boolean {
  return supportsExecutionHostCapability(capabilities, "acpRuntime");
}

export function getUnavailableGitCommandCapability(
  capabilities: ExecutionHostCapabilities,
  scope: GitCommandScope,
): "git" | "managedWorktrees" | null {
  const supportsGitRpc = supportsExecutionHostCapability(
    capabilities,
    "git",
  );
  const supportsLegacyGit = capabilities.git === 1
    && supportsExecutionHostCapability(capabilities, "commandExecution");
  if (!supportsGitRpc && !supportsLegacyGit) {
    return "git";
  }
  if (scope === "repository") {
    return null;
  }
  const supportsWorktreeRpc = supportsGitRpc
    && supportsExecutionHostCapability(capabilities, "managedWorktrees");
  const supportsLegacyWorktrees = supportsLegacyGit
    && capabilities.managedWorktrees === 1;
  return supportsWorktreeRpc || supportsLegacyWorktrees
    ? null
    : "managedWorktrees";
}

export function supportsWorkspaceExecutionHost(
  capabilities: ExecutionHostCapabilities,
): boolean {
  return WORKSPACE_EXECUTION_HOST_CAPABILITIES.every((capability) =>
    capability === "acpRuntime"
      ? supportsAcpRuntime(capabilities)
      : supportsExecutionHostCapability(capabilities, capability)
  );
}
