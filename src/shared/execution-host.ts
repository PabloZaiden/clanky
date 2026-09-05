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

export type ExecutionHostRef =
  | { kind: "local"; nodeId: string }
  | { kind: "mesh"; nodeId: string }
  | { kind: "ssh"; serverId: string };

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

export const EXECUTION_HOST_AVAILABILITIES = [
  "local",
  "available",
  "online",
  "offline",
  "unavailable",
  "revoked",
] as const;
export type ExecutionHostAvailability =
  typeof EXECUTION_HOST_AVAILABILITIES[number];

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

export interface ExecutionHostDescriptor {
  ref: ExecutionHostRef;
  targetKey: string;
  name: string;
  endpoint: string | null;
  repositoriesBasePath: string | null;
  preferredModel: ExecutionHostModelConfig | null;
  configurationRevision: number;
  availability: ExecutionHostAvailability;
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
  return ref.kind === "ssh" ? ref.serverId : ref.nodeId;
}

export function executionHostRefFromParts(
  kind: string,
  sourceId: string,
): ExecutionHostRef | null {
  if (kind === "local" || kind === "mesh") {
    return { kind, nodeId: sourceId };
  }
  if (kind === "ssh") {
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
