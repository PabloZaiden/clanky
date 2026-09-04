/**
 * Resolves transport-neutral execution-host operations to concrete adapters.
 */

import type {
  ExecutionHostBinding,
  ExecutionHostCapabilities,
  ExecutionHostDescriptor,
  ExecutionHostRef,
} from "@/shared/execution-host";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "@/shared/execution-host";
import type { AgentProvider } from "@/shared/settings";
import {
  getExecutionHostByRef,
  ensureExecutionHost,
  listExecutionHosts,
  type PersistedExecutionHost,
} from "../persistence/execution-hosts";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import {
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import {
  listSshServerConfigs,
} from "../persistence/ssh-servers";
import {
  buildLocalTargetKey,
  buildMeshTargetKey,
  buildSshTargetKey,
} from "../persistence/workspace-target-key";
import { ensureLocalInstallationId } from "../persistence/installation-identity";
import type { CommandExecutor } from "./command-executor";
import { DomainError } from "./domain-error";
import { MeshCommandExecutor } from "./mesh-command-executor";
import { CommandExecutorImpl } from "./remote-command-executor";
import type { SshConnectionTarget } from "./ssh-connection-target";
import { sshServerManager } from "./ssh-server-manager";
import { requireCurrentUserId } from "./user-context";

export interface ExecutionHostCommandContext {
  directory: string;
  provider: AgentProvider;
  operationId: string;
  localUserId?: string;
  sshPassword?: string;
  sshTargetOverride?: SshConnectionTarget;
}

const DIRECT_HOST_CAPABILITIES: ExecutionHostCapabilities = {
  ...DEFAULT_EXECUTION_HOST_CAPABILITIES,
  tcpTunnel: 1,
};

function assertCurrentBinding(
  binding: ExecutionHostBinding,
  persisted: PersistedExecutionHost | null,
): void {
  if (!persisted || persisted.revokedAt) {
    throw new DomainError(
      "execution_host_unavailable",
      "The selected execution host is unavailable.",
    );
  }
  if (
    persisted.targetKey !== binding.targetKey
    || persisted.revision !== binding.revision
  ) {
    throw new DomainError(
      "execution_host_binding_stale",
      "The selected execution host changed after this operation was configured.",
    );
  }
}

export class ExecutionHostService {
  private testExecutorFactory: ((directory: string) => CommandExecutor) | null = null;

  setExecutorFactoryForTesting(
    factory: ((directory: string) => CommandExecutor) | null,
  ): void {
    this.testExecutorFactory = factory;
  }

  validateBinding(
    binding: ExecutionHostBinding,
    userId: string = requireCurrentUserId(),
  ): PersistedExecutionHost {
    const persisted = getExecutionHostByRef(userId, binding.host);
    assertCurrentBinding(binding, persisted);
    return persisted!;
  }

  async listHosts(userId: string = requireCurrentUserId()): Promise<ExecutionHostDescriptor[]> {
    const descriptors: ExecutionHostDescriptor[] = [];
    const identity = await ensureLocalMeshNodeIdentity();
    if (identity.execution?.acceptRemoteExecution !== false) {
      const localHost = ensureExecutionHost(
        userId,
        { kind: "local", nodeId: identity.nodeId },
        buildLocalTargetKey(await ensureLocalInstallationId()),
      );
      descriptors.push({
        ref: localHost.ref,
        targetKey: localHost.targetKey,
        name: identity.execution?.name || identity.instanceName || "Local",
        endpoint: identity.execution?.endpoint ?? identity.meshEndpoint,
        repositoriesBasePath: identity.execution?.repositoriesBasePath ?? null,
        availability: "local",
        accessRequirement: { kind: "none" },
        acceptRemoteExecution: true,
        capabilities: identity.execution?.capabilities ?? DIRECT_HOST_CAPABILITIES,
        revision: localHost.revision,
      });
    }

    const link = await getMeshLinkForLocalUser(userId);
    if (link?.status === "active") {
      for (const member of await listMeshLinkMembers(link.linkId)) {
        if (member.nodeId === identity.nodeId || member.status === "revoked") {
          continue;
        }
        const node = await getMeshNode(member.nodeId);
        if (!node?.execution?.acceptRemoteExecution) {
          continue;
        }
        const host = ensureExecutionHost(
          userId,
          { kind: "mesh", nodeId: member.nodeId },
          buildMeshTargetKey(member.nodeId),
        );
        descriptors.push({
          ref: host.ref,
          targetKey: host.targetKey,
          name: node.execution.name || node.instanceName || member.nodeId,
          endpoint: member.endpoint ?? node.endpoint,
          repositoriesBasePath: node.execution.repositoriesBasePath,
          availability: member.status === "active" && Boolean(member.endpoint ?? node.endpoint)
            ? "online"
            : "offline",
          accessRequirement: { kind: "none" },
          acceptRemoteExecution: true,
          capabilities: node.execution.capabilities,
          revision: host.revision,
        });
      }
    }

    for (const server of await listSshServerConfigs()) {
      const host = ensureExecutionHost(
        userId,
        { kind: "ssh", serverId: server.id },
        buildSshTargetKey(server.address, server.port ?? 22, server.username),
      );
      descriptors.push({
        ref: host.ref,
        targetKey: host.targetKey,
        name: server.name,
        endpoint: `${server.address}:${String(server.port ?? 22)}`,
        repositoriesBasePath: server.repositoriesBasePath,
        availability: host.revokedAt ? "revoked" : "unavailable",
        accessRequirement: {
          kind: "sshCredentials",
          serverId: server.id,
          methods: ["agent", "password"],
        },
        acceptRemoteExecution: !host.revokedAt,
        capabilities: DIRECT_HOST_CAPABILITIES,
        revision: host.revision,
        isPrivate: server.isPrivate,
      });
    }

    return descriptors;
  }

  getRegisteredHosts(userId: string = requireCurrentUserId()): PersistedExecutionHost[] {
    return listExecutionHosts(userId);
  }

  getBinding(
    ref: ExecutionHostRef,
    userId: string = requireCurrentUserId(),
  ): ExecutionHostBinding {
    const host = getExecutionHostByRef(userId, ref);
    if (!host || host.revokedAt) {
      throw new DomainError(
        "execution_host_unavailable",
        "The selected execution host is unavailable.",
      );
    }
    return {
      host: host.ref,
      targetKey: host.targetKey,
      revision: host.revision,
    };
  }

  async getCommandExecutor(
    binding: ExecutionHostBinding,
    context: ExecutionHostCommandContext,
  ): Promise<CommandExecutor> {
    const userId = context.localUserId ?? requireCurrentUserId();
    this.validateBinding(binding, userId);
    return await this.getCommandExecutorForRef(binding.host, {
      ...context,
      localUserId: userId,
    });
  }

  async getCommandExecutorForRef(
    host: ExecutionHostRef,
    context: ExecutionHostCommandContext,
  ): Promise<CommandExecutor> {
    const userId = context.localUserId ?? requireCurrentUserId();
    if (host.kind !== "ssh" && this.testExecutorFactory) {
      return this.testExecutorFactory(context.directory);
    }
    if (host.kind === "local") {
      const localIdentity = await ensureLocalMeshNodeIdentity();
      if (localIdentity.nodeId !== host.nodeId) {
        throw new DomainError(
          "execution_host_unavailable",
          "The selected local execution host does not belong to this installation.",
        );
      }
      return new CommandExecutorImpl({
        provider: "local",
        directory: context.directory,
      });
    }

    if (host.kind === "mesh") {
      return new MeshCommandExecutor({
        workspaceId: context.operationId,
        directory: context.directory,
        executionNodeId: host.nodeId,
        provider: context.provider,
        localUserId: userId,
      });
    }

    if (context.sshTargetOverride) {
      return new CommandExecutorImpl({
        provider: "ssh",
        directory: context.directory,
        host: context.sshTargetOverride.host,
        port: context.sshTargetOverride.port,
        user: context.sshTargetOverride.username,
        password: context.sshTargetOverride.password ?? context.sshPassword,
        identityFile: context.sshTargetOverride.identityFile,
      });
    }
    return (await sshServerManager.getCommandExecutor(
      host.serverId,
      context.sshPassword,
    )).executor;
  }
}

export const executionHostService = new ExecutionHostService();
