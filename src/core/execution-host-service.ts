/**
 * Resolves transport-neutral execution-host operations to concrete adapters.
 */

import type {
  ExecutionHostBinding,
  ExecutionHostCapabilityId,
  ExecutionHostCapabilities,
  ExecutionHostDescriptor,
  ExecutionHostRef,
} from "@/shared/execution-host";
import {
  POSIX_EXECUTION_HOST_CAPABILITIES,
  createExecutionHostRuntimeSnapshot,
  executionHostRefsEqual,
  getExecutionHostAgentProvider,
  executionHostReferenceMatches,
  isPrivateMeshExecutionHostRef,
  isWorkspaceSshExecutionHostRef,
  supportsExecutionHostCapability,
} from "@/shared/execution-host";
import type { AgentProvider } from "@/shared/settings";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  getExecutionHostByRef,
  ensureExecutionHost,
  listExecutionHosts,
  updateExecutionHostRuntimeSnapshot,
  type PersistedExecutionHost,
} from "../persistence/execution-hosts";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import { listGloballyDiscoverableWorkerRegistrations } from "../persistence/mesh";
import {
  listSshServerConfigs,
} from "../persistence/ssh-servers";
import {
  buildLocalTargetKey,
  buildMeshTargetKey,
  buildSshTargetKey,
} from "../persistence/workspace-target-key";
import { ensureLocalInstallationId } from "../persistence/installation-identity";
import {
  closeCommandExecutor,
  type CommandExecutor,
} from "./command-executor";
import { isRemoteOnlyMode } from "./config";
import { DomainError } from "./domain-error";
import { MeshCommandExecutor } from "./mesh-command-executor";
import { CommandExecutorImpl } from "./remote-command-executor";
import type { SshConnectionTarget } from "./ssh-connection-target";
import { sshServerManager } from "./ssh-server-manager";
import { requireCurrentUserId } from "./user-context";
import { getWorkspaceSshTarget } from "../persistence/workspace-execution-targets";
import {
  executionPathStyleForPlatform,
  resolveExecutionPathUnscoped,
} from "./execution-path";
import { AGENT_PROVIDER_IDS } from "../constants/agent-providers";
import { meshHealthService } from "./mesh-health-service";

const log = createLogger("core:execution-host-service");

export interface ExecutionHostCommandContext {
  directory: string;
  provider?: AgentProvider;
  operationId: string;
  localUserId?: string;
  sshPassword?: string;
  sshTargetOverride?: SshConnectionTarget;
}

const SSH_HOST_CAPABILITIES: ExecutionHostCapabilities = {
  ...POSIX_EXECUTION_HOST_CAPABILITIES,
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

function assertExecutionHostAllowedInCurrentMode(ref: ExecutionHostRef): void {
  if (isRemoteOnlyMode() && ref.kind === "local") {
    throw new DomainError(
      "execution_host_unavailable",
      "The local execution host is disabled in remote-only mode.",
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
    assertExecutionHostAllowedInCurrentMode(binding.host);
    const persisted = getExecutionHostByRef(userId, binding.host);
    assertCurrentBinding(binding, persisted);
    return persisted!;
  }

  requireBindingCapability(
    binding: ExecutionHostBinding,
    capability: ExecutionHostCapabilityId,
    userId: string = requireCurrentUserId(),
    minimumVersion?: number,
  ): PersistedExecutionHost {
    let persisted = this.validateBinding(binding, userId);
    const runtime = binding.host.kind === "local"
      ? createExecutionHostRuntimeSnapshot(process.platform, process.arch)
      : binding.host.kind === "ssh"
        ? {
            platform: null,
            capabilities: SSH_HOST_CAPABILITIES,
          }
        : null;
    if (runtime) {
      persisted = updateExecutionHostRuntimeSnapshot(
        userId,
        binding.host,
        runtime,
      ) ?? persisted;
    }
    if (!supportsExecutionHostCapability(
      persisted.runtime.capabilities,
      capability,
      minimumVersion,
    )) {
      throw new DomainError(
        "execution_host_capability_unavailable",
        `The selected execution host does not provide the ${capability} capability.`,
        {
          details: {
            capability,
            requiredVersion: minimumVersion ?? 1,
            actualVersion: persisted.runtime.capabilities[capability] ?? 0,
          },
        },
      );
    }
    return persisted;
  }

  async listHosts(userId: string = requireCurrentUserId()): Promise<ExecutionHostDescriptor[]> {
    const descriptors: ExecutionHostDescriptor[] = [];
    const identity = await ensureLocalMeshNodeIdentity();
    const localRuntime = createExecutionHostRuntimeSnapshot(
      process.platform,
      process.arch,
    );
    if (!isRemoteOnlyMode() && identity.execution?.acceptRemoteExecution !== false) {
      const localHost = ensureExecutionHost(
        userId,
        { kind: "local", nodeId: identity.nodeId },
        buildLocalTargetKey(await ensureLocalInstallationId()),
        { runtime: localRuntime },
      );
      descriptors.push({
        ref: localHost.ref,
        targetKey: localHost.targetKey,
        name: identity.execution?.name || identity.instanceName || "Local",
        endpoint: identity.execution?.endpoint ?? identity.meshEndpoint,
        meshRouteKind: null,
        repositoriesBasePath: identity.execution?.repositoriesBasePath ?? null,
        preferredModel: identity.execution?.preferredModel ?? null,
        configurationRevision: identity.execution?.revision ?? 1,
        accessRequirement: { kind: "none" },
        acceptRemoteExecution: true,
        platform: localHost.runtime.platform,
        capabilities: localHost.runtime.capabilities,
        revision: localHost.revision,
      });
    }

    for (const worker of await listGloballyDiscoverableWorkerRegistrations(userId)) {
      if (worker.workerNodeId === identity.nodeId || !worker.workerAcceptRemoteExecution) {
        continue;
      }
      const host = ensureExecutionHost(
        userId,
        { kind: "mesh", nodeId: worker.workerNodeId },
        buildMeshTargetKey(worker.workerNodeId),
        {
          runtime: {
            platform: worker.workerPlatform,
            capabilities: worker.workerCapabilities ?? {},
          },
        },
      );
      descriptors.push({
        ref: host.ref,
        targetKey: host.targetKey,
        name: worker.workerInstanceName || worker.workerNodeId,
        endpoint: worker.workerEndpoint,
        meshRouteKind: worker.route.kind,
        repositoriesBasePath: worker.workerDirectory,
        preferredModel: null,
        configurationRevision: worker.workerConfigRevision,
        accessRequirement: { kind: "none" },
        acceptRemoteExecution: true,
        platform: host.runtime.platform,
        capabilities: host.runtime.capabilities,
        revision: host.revision,
      });
    }

    for (const server of await listSshServerConfigs()) {
      const host = ensureExecutionHost(
        userId,
        { kind: "ssh", serverId: server.id },
        buildSshTargetKey(server.address, server.port ?? 22, server.username),
        {
          runtime: {
            platform: null,
            capabilities: SSH_HOST_CAPABILITIES,
          },
        },
      );
      descriptors.push({
        ref: host.ref,
        targetKey: host.targetKey,
        name: server.name,
        endpoint: `${server.address}:${String(server.port ?? 22)}`,
        meshRouteKind: null,
        repositoriesBasePath: server.repositoriesBasePath,
        preferredModel: null,
        configurationRevision: host.revision,
        accessRequirement: {
          kind: "sshCredentials",
          serverId: server.id,
          methods: ["agent", "password"],
        },
        acceptRemoteExecution: !host.revokedAt,
        platform: host.runtime.platform,
        capabilities: host.runtime.capabilities,
        revision: host.revision,
        isPrivate: server.isPrivate,
      });
    }

    return descriptors;
  }

  async requireCapability(
    ref: ExecutionHostRef,
    capability: ExecutionHostCapabilityId,
    userId: string = requireCurrentUserId(),
    minimumVersion?: number,
  ): Promise<ExecutionHostDescriptor> {
    let descriptor = (await this.listHosts(userId))
      .find((candidate) => executionHostRefsEqual(candidate.ref, ref));
    if (!descriptor) {
      throw new DomainError(
        "execution_host_unavailable",
        "The selected execution host is unavailable.",
      );
    }

    if (!supportsExecutionHostCapability(descriptor.capabilities, capability, minimumVersion)
      && ref.kind === "mesh") {
      try {
        await meshHealthService.refreshWorker(userId, ref.nodeId);
        descriptor = (await this.listHosts(userId))
          .find((candidate) => executionHostRefsEqual(candidate.ref, ref));
      } catch (error) {
        log.warn("Mesh worker capability refresh failed", {
          workerNodeId: ref.nodeId,
          capability,
          error: String(error),
        });
      }
    }

    if (!descriptor || !supportsExecutionHostCapability(
      descriptor.capabilities,
      capability,
      minimumVersion,
    )) {
      throw new DomainError(
        "execution_host_capability_unavailable",
        `The selected execution host does not provide the ${capability} capability.`,
        {
          details: {
            capability,
            requiredVersion: minimumVersion ?? 1,
            actualVersion: descriptor?.capabilities[capability] ?? 0,
          },
        },
      );
    }
    return descriptor;
  }

  async resolveReference(
    reference: string,
    userId: string = requireCurrentUserId(),
  ): Promise<ExecutionHostDescriptor> {
    const normalized = reference.trim();
    if (!normalized) {
      throw new DomainError(
        "execution_host_reference_required",
        "Execution host is required.",
      );
    }
    const matches = (await this.listHosts(userId)).filter((host) =>
      executionHostReferenceMatches(host, normalized)
    );
    if (matches.length === 0) {
      throw new DomainError(
        "execution_host_not_found",
        "Execution host not found.",
        { details: { reference: normalized } },
      );
    }
    if (matches.length > 1) {
      throw new DomainError(
        "execution_host_name_ambiguous",
        "Execution host name is ambiguous.",
        {
          details: {
            reference: normalized,
            candidates: matches.map((host) => ({
              name: host.name,
              ref: host.ref,
            })),
          },
        },
      );
    }
    return matches[0]!;
  }

  getRegisteredHosts(userId: string = requireCurrentUserId()): PersistedExecutionHost[] {
    return listExecutionHosts(userId);
  }

  async resolveWorkingDirectory(
    ref: ExecutionHostRef,
    options: {
      userId?: string;
      sshPassword?: string;
    } = {},
  ): Promise<{ directory: string; configured: boolean }> {
    const userId = options.userId ?? requireCurrentUserId();
    const descriptor = await this.requireCapability(
      ref,
      "fileOperations",
      userId,
    );
    const configuredDirectory = descriptor.repositoriesBasePath?.trim();
    if (configuredDirectory && configuredDirectory !== ".") {
      return {
        directory: configuredDirectory,
        configured: true,
      };
    }
    if (ref.kind === "local") {
      return {
        directory: process.cwd(),
        configured: configuredDirectory === ".",
      };
    }

    const executor = await this.getCommandExecutorForRef(ref, {
      operationId: `working-directory:${descriptor.targetKey}`,
      directory: ".",
      localUserId: userId,
      sshPassword: options.sshPassword,
    });
    const result = await (async () => {
      try {
        return await executor.exec("/bin/pwd", [], {
          cwd: ".",
          maxOutputBytes: 16 * 1024,
        });
      } finally {
        closeCommandExecutor(executor);
      }
    })();
    const directory = result.stdout.trim();
    if (!result.success || !directory) {
      throw new DomainError(
        "execution_host_directory_unavailable",
        "The execution host current directory could not be resolved.",
        { details: { stderr: result.stderr.trim(), exitCode: result.exitCode } },
      );
    }
    return { directory, configured: configuredDirectory === "." };
  }

  async assertDirectoryExists(
    ref: ExecutionHostRef,
    directory: string,
    options: {
      userId?: string;
      sshPassword?: string;
    } = {},
  ): Promise<void> {
    const userId = options.userId ?? requireCurrentUserId();
    await this.requireCapability(ref, "fileOperations", userId);
    const binding = this.getBinding(ref, userId);
    const executor = await this.getCommandExecutor(binding, {
      operationId: `validate-directory:${binding.targetKey}`,
      directory: ".",
      localUserId: userId,
      sshPassword: options.sshPassword,
    });
    const directoryExists = await (async () => {
      try {
        const executionDirectory = await executor.getExecutionDirectory();
        const absoluteDirectory = resolveExecutionPathUnscoped(
          executionDirectory,
          directory,
          executor.pathStyle,
        );
        return await executor.directoryExists(absoluteDirectory);
      } finally {
        closeCommandExecutor(executor);
      }
    })();
    if (!directoryExists) {
      throw new DomainError(
        "execution_host_directory_invalid",
        "The selected directory does not exist on the execution host.",
      );
    }
  }

  async resolveAgentProvider(
    ref: ExecutionHostRef,
    userId: string = requireCurrentUserId(),
  ): Promise<AgentProvider> {
    const descriptor = (await this.listHosts(userId))
      .find((candidate) => executionHostRefsEqual(candidate.ref, ref));
    if (!descriptor) {
      throw new DomainError(
        "execution_host_unavailable",
        "The selected execution host is unavailable.",
      );
    }
    return getExecutionHostAgentProvider(descriptor);
  }

  getBinding(
    ref: ExecutionHostRef,
    userId: string = requireCurrentUserId(),
  ): ExecutionHostBinding {
    assertExecutionHostAllowedInCurrentMode(ref);
    if (isPrivateMeshExecutionHostRef(ref)) {
      throw new DomainError(
        "execution_host_private",
        "This execution host is private to its workspace.",
      );
    }
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

  async discoverAgentProviders(
    ref: ExecutionHostRef,
    context: ExecutionHostCommandContext,
  ): Promise<Array<{ providerID: AgentProvider; available: boolean }>> {
    const userId = context.localUserId ?? requireCurrentUserId();
    await this.requireCapability(ref, "acpRuntime", userId, 1);
    const binding = this.getBinding(ref, userId);
    const executor = await this.getCommandExecutor(binding, {
      ...context,
      localUserId: userId,
    });
    try {
      return await Promise.all(
        AGENT_PROVIDER_IDS.map(async (providerID) => ({
          providerID,
          available: await executor.isAgentProviderAvailable(providerID),
        })),
      );
    } finally {
      closeCommandExecutor(executor);
    }
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
    assertExecutionHostAllowedInCurrentMode(host);
    const userId = context.localUserId ?? requireCurrentUserId();
    if (this.testExecutorFactory && host.kind !== "ssh") {
      return this.testExecutorFactory(context.directory);
    }
    if (this.testExecutorFactory && isWorkspaceSshExecutionHostRef(host)) {
      const target = await getWorkspaceSshTarget(host.workspaceId, userId);
      if (!target) {
        throw new DomainError(
          "workspace_execution_target_missing",
          "The workspace SSH execution target is not configured.",
          { details: { workspaceId: host.workspaceId } },
        );
      }
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
      const runtime = getExecutionHostByRef(userId, host)?.runtime;
      const pathStyle = runtime?.platform
        ? executionPathStyleForPlatform(runtime.platform.os)
        : null;
      return new MeshCommandExecutor({
        workspaceId: context.operationId,
        directory: context.directory,
        executionNodeId: host.nodeId,
        provider: context.provider
          ?? (isPrivateMeshExecutionHostRef(host)
            ? "copilot"
            : await this.resolveAgentProvider(host, userId)),
        localUserId: userId,
        pathStyle,
        capabilities: runtime?.capabilities ?? {},
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
    if (isWorkspaceSshExecutionHostRef(host)) {
      const target = await getWorkspaceSshTarget(host.workspaceId, userId);
      if (!target) {
        throw new DomainError(
          "workspace_execution_target_missing",
          "The workspace SSH execution target is not configured.",
          { details: { workspaceId: host.workspaceId } },
        );
      }
      return new CommandExecutorImpl({
        provider: "ssh",
        directory: context.directory,
        host: target.host,
        port: target.port,
        user: target.username,
        password: target.password,
      });
    }
    return (await sshServerManager.getCommandExecutor(
      host.serverId,
      context.sshPassword,
    )).executor;
  }

  async getCommandExecutorForSshTarget(
    target: SshConnectionTarget,
    context: Pick<ExecutionHostCommandContext, "directory" | "operationId"> & {
      sshPassword?: string;
    },
  ): Promise<CommandExecutor> {
    return new CommandExecutorImpl({
      provider: "ssh",
      directory: context.directory,
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password ?? context.sshPassword,
      identityFile: target.identityFile,
    });
  }
}

export const executionHostService = new ExecutionHostService();
