/**
 * Backend manager for Clanky Tasks Management System.
 * Manages multiple workspace-specific backend connections.
 *
 * Each workspace can have its own server settings and connection,
 * allowing parallel operation of tasks across different workspaces.
 */

import {
  WorkspaceAcpTransportLifecycle,
  createAcpConnectionTimeoutError,
} from "../../backends/acp";
import type { Backend, BackendConnectionConfig } from "../../backends/types";
import { createLocalHarnessBackend } from "../../backends/harness-factory";
import { HarnessError } from "../../backends/harness-errors";
import { getWorkspace } from "../../persistence/workspaces";
import {
  getDefaultRuntimeServerSettings,
  createAgentSettings,
  areServerSettingsEqual,
  type AgentSettings,
  type RuntimeServerSettings,
  type ServerSettings,
} from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { meshStateEventEmitter, taskEventEmitter, type MeshStateEvent } from "../event-emitter";
import type { TaskEvent } from "@/shared/events";
import {
  closeCommandExecutor,
  resolveCommandExecutorDirectory,
  type CommandExecutor,
} from "../command-executor";
import { GitService } from "../git";
import { log } from "@pablozaiden/webapp/server";
import { buildConnectionConfig } from "./backend-connection-pool";
import {
  deriveExecutionSettings,
  areRuntimeServerSettingsEqual,
  buildAgentServerUrl,
  type WorkspaceConnectionState,
  type TaskConnectionState,
  type ServerEvent,
} from "./backend-state";
import { ensureLocalMeshNodeIdentity } from "../../persistence/mesh-node-identity";
import { getWorkerRegistration } from "../../persistence/mesh";
import { requireExecutionOwnerUserId } from "../../context/user-context";
import { getSshReliabilityPolicy } from "../ssh-reliability-policy";
import { executionHostService } from "../execution-host-service";
import { executionHostBindingsEqual, getAgentExecutionHostCapability } from "@/shared/execution-host";
import { isWorkspaceSshExecutionHostRef } from "@/shared/execution-host";
import type {
  ExecutionHostBinding,
  ExecutionHostRef,
} from "@/shared/execution-host";
import type { AgentProvider } from "@/shared/settings";
import { getSshServerConfig } from "../../persistence/ssh-servers";
import {
  getWorkspaceSshTarget,
  type WorkspaceSshTargetInput,
} from "../../persistence/workspace-execution-targets";
import type { SshConnectionTarget } from "../ssh-connection-target";
import { assertHarnessHostPolicy } from "./harness-host-policy";
import { isRemoteOnlyMode } from "../config";
import { MeshHarnessBackend } from "../../backends/mesh-harness-backend";
import { createRetryableAsyncOperation } from "../../utils/async-operation";
import { harnessActivityService } from "../harness-activity-service";

interface WorkspaceBackendOptions {
  workspaceId: string;
  localNodeId: string | null;
  executionHostBinding: ExecutionHostBinding;
}

interface CachedCommandExecutor {
  executor: CommandExecutor;
  workspaceId: string;
  userId: string;
  executionHostBinding: ExecutionHostBinding;
  capabilitySnapshot: string | null;
}

interface PendingExecutionHost {
  userId: string;
  executionHostBinding: ExecutionHostBinding;
  workspaceId?: string;
  invalidated: boolean;
}

interface PendingTaskDisconnect {
  state: TaskConnectionState;
  promise: Promise<boolean>;
}

interface OperationConnection {
  userId: string;
  workspaceId: string;
  executionHostBinding: ExecutionHostBinding;
  controller: AbortController;
  close: () => Promise<void>;
}

/**
 * Backend manager supporting multiple workspace connections.
 * Each workspace can have its own server settings and connection.
 */
class BackendManager {
  /** Map of workspace ID to connection state (for workspace-level operations) */
  private connections = new Map<string, WorkspaceConnectionState>();
  /** Map of task ID to its own dedicated backend connection */
  private taskConnections = new Map<string, TaskConnectionState>();
  /** In-flight teardown results keyed by the task/chat backend owner. */
  private readonly taskDisconnects = new Map<string, PendingTaskDisconnect>();
  private readonly operationConnections = new Map<Backend, OperationConnection>();
  /** Map of workspace execution key to command executor. */
  private commandExecutors = new Map<string, CachedCommandExecutor>();
  private readonly pendingExecutionHosts = new Set<PendingExecutionHost>();
  private initialized = false;
  private shuttingDown = false;
  private unsubscribeMeshState: (() => void) | undefined;
  private readonly connectionTimeoutMs = getSshReliabilityPolicy().connectionTimeoutMs;
  private localMeshNodeId: string | null = null;
  private localMeshNodeIdPromise: Promise<string> | null = null;
  private localMeshNodeIdGeneration = 0;

  private async getLocalMeshNodeId(): Promise<string> {
    if (this.localMeshNodeId) {
      return this.localMeshNodeId;
    }

    if (!this.localMeshNodeIdPromise) {
      const generation = this.localMeshNodeIdGeneration;
      const identityPromise = ensureLocalMeshNodeIdentity().then((identity) => {
        if (this.localMeshNodeIdGeneration === generation) {
          this.localMeshNodeId = identity.nodeId;
        }
        return identity.nodeId;
      });
      this.localMeshNodeIdPromise = identityPromise;
    }

    const identityPromise = this.localMeshNodeIdPromise;
    try {
      return await identityPromise;
    } finally {
      if (this.localMeshNodeIdPromise === identityPromise) {
        this.localMeshNodeIdPromise = null;
      }
    }
  }

  invalidateLocalMeshNodeIdCache(): void {
    this.localMeshNodeIdGeneration += 1;
    this.localMeshNodeId = null;
    this.localMeshNodeIdPromise = null;
  }

  private async getWorkspaceBackendOptions(
    workspace: Workspace,
  ): Promise<WorkspaceBackendOptions> {
    const localNodeId = await this.getLocalMeshNodeId();
    return {
      workspaceId: workspace.id,
      localNodeId,
      executionHostBinding: workspace.executionHostBinding,
    };
  }

  private async buildRuntimeSettings(
    binding: ExecutionHostBinding,
    agent: AgentSettings,
    sshPassword?: string,
    sshTargetOverride?: SshConnectionTarget,
  ): Promise<RuntimeServerSettings> {
    executionHostService.validateBinding(binding);
    assertHarnessHostPolicy(agent, binding.host.kind);
    executionHostService.requireBindingCapability(
      binding,
      getAgentExecutionHostCapability(agent.adapter),
      undefined,
      1,
    );
    if (binding.host.kind !== "ssh") {
      return {
        agent: {
          ...agent,
          transport: "stdio",
        },
      };
    }
    if (isWorkspaceSshExecutionHostRef(binding.host)) {
      const target = sshTargetOverride
        ?? await getWorkspaceSshTarget(binding.host.workspaceId);
      if (!target) {
        throw new Error(
          `Workspace SSH execution target not found: ${binding.host.workspaceId}`,
        );
      }
      return {
        agent: {
          ...agent,
          transport: "ssh",
          hostname: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
        },
      };
    }
    const server = await getSshServerConfig(binding.host.serverId, requireExecutionOwnerUserId());
    if (!server) {
      throw new Error(`SSH server not found: ${binding.host.serverId}`);
    }
    return {
      agent: {
        ...agent,
        transport: "ssh",
        hostname: server.address,
        port: server.port ?? 22,
        username: server.username,
        password: sshPassword,
      },
    };
  }

  /**
   * Create a backend instance for the configured agent provider.
   */
  private createBackendForSettings(
    settings: RuntimeServerSettings,
    workspaceOptions?: WorkspaceBackendOptions,
  ): Backend {
    this.assertAcceptingConnections();
    const transportLifecycleFactory = workspaceOptions && settings.agent.transport === "stdio"
      ? () => new WorkspaceAcpTransportLifecycle({
          workspaceId: workspaceOptions.workspaceId,
          localNodeId: workspaceOptions.localNodeId ?? "",
          executionNodeId: workspaceOptions.executionHostBinding.host.kind === "ssh"
            ? null
            : workspaceOptions.executionHostBinding.host.nodeId,
        })
      : undefined;
    if (settings.agent.adapter !== "acp") {
      if (settings.agent.transport === "ssh") throw new HarnessError("harness_unsupported_feature", "Direct SSH supports ACP only.");
      if (workspaceOptions && (
        workspaceOptions.executionHostBinding.host.kind === "ssh"
        || workspaceOptions.executionHostBinding.host.nodeId !== workspaceOptions.localNodeId
      )) {
        const host = workspaceOptions.executionHostBinding.host;
        if (host.kind !== "mesh") throw new HarnessError("harness_unsupported_feature", "The selected execution host does not support native Mesh routing.");
        return new MeshHarnessBackend({
          adapter: settings.agent.adapter, workspaceId: workspaceOptions.workspaceId, executionNodeId: host.nodeId,
        });
      }
      if (isRemoteOnlyMode()) {
        throw new HarnessError("harness_unsupported_feature", "Local harness execution is disabled in remote-only mode.");
      }
    }
    return createLocalHarnessBackend(settings.agent.adapter, transportLifecycleFactory);
  }

  /**
   * Static capabilities exposed to the status endpoint.
   */
  private getAgentCapabilities(_settings: RuntimeServerSettings): string[] {
    return ["createSession", "sendPromptAsync", "abortSession", "subscribeToEvents", "models"];
  }

  /**
   * Ensure a workspace connection state exists and is hydrated from persisted settings.
   *
   * This avoids caching default local/stdio settings before the real workspace
   * configuration has been loaded from persistence.
   */
  private async ensureWorkspaceState(workspaceId: string, workspaceOverride?: Workspace): Promise<WorkspaceConnectionState> {
    const userId = requireExecutionOwnerUserId();
    const workspace = workspaceOverride ?? await getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const pending = this.trackPendingExecutionHost(userId, workspace.executionHostBinding, workspaceId);
    try {
      const settings = await this.buildRuntimeSettings(
        workspace.executionHostBinding,
        workspace.serverSettings.agent,
      );
      const workspaceOptions = await this.getWorkspaceBackendOptions(workspace);
      const current = await getWorkspace(workspaceId);
      this.assertPendingExecutionHost(pending);
      if (
        !current
        || !areServerSettingsEqual(current.serverSettings, workspace.serverSettings)
        || !executionHostBindingsEqual(current.executionHostBinding, workspace.executionHostBinding)
      ) {
        throw new HarnessError("harness_connection_aborted", "The workspace context changed while preparing its connection.");
      }
      const existing = this.connections.get(workspaceId);
      if (
        existing && existing.userId === userId
        && areRuntimeServerSettingsEqual(existing.settings, settings)
        && existing.executionHostBinding
        && executionHostBindingsEqual(existing.executionHostBinding, workspaceOptions.executionHostBinding)
      ) {
        return existing;
      }
      if (existing) {
        this.clearCommandExecutorsForWorkspace(workspaceId);
        if (!await this.closeWorkspaceBackend(workspaceId, existing)) {
          throw new Error("The previous workspace backend could not be closed.");
        }
        if (this.connections.get(workspaceId) === existing) this.connections.delete(workspaceId);
        this.assertPendingExecutionHost(pending);
        if (this.connections.has(workspaceId)) {
          return await this.ensureWorkspaceState(workspaceId);
        }
      }
      const state: WorkspaceConnectionState = {
        userId, backend: this.createBackendForSettings(settings, workspaceOptions),
        settings, connectionError: null, localNodeId: workspaceOptions.localNodeId,
        executionHostBinding: structuredClone(workspaceOptions.executionHostBinding),
      };
      this.connections.set(workspaceId, state);
      return state;
    } finally {
      this.pendingExecutionHosts.delete(pending);
    }
  }

  private trackPendingExecutionHost(userId: string, binding: ExecutionHostBinding, workspaceId?: string): PendingExecutionHost {
    this.assertAcceptingConnections();
    const pending = { userId, executionHostBinding: structuredClone(binding), workspaceId, invalidated: false };
    this.pendingExecutionHosts.add(pending);
    return pending;
  }

  private assertPendingExecutionHost(pending: PendingExecutionHost): void {
    this.assertAcceptingConnections();
    if (pending.invalidated) {
      throw new HarnessError("harness_connection_aborted", "The execution host changed while preparing its connection.");
    }
  }

  private assertAcceptingConnections(): void {
    if (this.shuttingDown) {
      throw new HarnessError("harness_connection_aborted", "The server is shutting down.");
    }
  }

  private buildCommandExecutorCacheKey(workspaceId: string, directory: string, settings: RuntimeServerSettings): string {
    const execution = deriveExecutionSettings(settings);
    return JSON.stringify({
      workspaceId,
      directory,
      provider: execution.provider,
      sshTarget: execution.sshTarget ?? null,
      executionHostBinding: this.connections.get(workspaceId)?.executionHostBinding ?? null,
    });
  }

  private clearCommandExecutorsForWorkspace(workspaceId: string): void {
    for (const [key, cached] of this.commandExecutors) {
      if (cached.workspaceId === workspaceId) {
        this.evictCommandExecutor(key);
      }
    }
  }

  private clearAllCommandExecutors(): void {
    for (const key of this.commandExecutors.keys()) {
      this.evictCommandExecutor(key);
    }
  }

  private evictCommandExecutor(cacheKey: string): void {
    const cached = this.commandExecutors.get(cacheKey);
    if (!cached) {
      return;
    }

    this.commandExecutors.delete(cacheKey);
    try {
      closeCommandExecutor(cached.executor);
    } catch (error) {
      log.error("[BackendManager] Error closing cached CommandExecutor", {
        error: String(error),
      });
    }
  }

  /**
   * Initialize the backend manager.
   * No longer loads global settings - settings are per-workspace.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.unsubscribeMeshState = meshStateEventEmitter.subscribe((event) => {
      if (event.impact === "inventory") {
        return;
      }
      void this.invalidateMeshExecutionConnections(event).catch((error: unknown) => {
        log.error("Failed to invalidate Mesh execution connections", {
          error: String(error),
        });
      });
    });
  }

  /**
   * Borrow only a matching workspace connection; incompatible operations own
   * a separate backend until their callback and session cleanup have finished.
   */
  async withWorkspaceBackend<T>(
    options: {
      workspaceId: string;
      directory: string;
      settings?: ServerSettings;
      expectedBinding?: ExecutionHostBinding;
    },
    operation: (backend: Backend) => Promise<T>,
  ): Promise<T> {
    const userId = requireExecutionOwnerUserId();
    const expectedBinding = options.expectedBinding && structuredClone(options.expectedBinding);
    const workspace = await getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspaceId}`);
    }
    if (expectedBinding && !executionHostBindingsEqual(expectedBinding, workspace.executionHostBinding)) {
      throw new HarnessError("harness_connection_aborted", "The workspace execution host changed before preparing its operation.");
    }
    const pending = this.trackPendingExecutionHost(userId, workspace.executionHostBinding, workspace.id);
    try {
      const state = await this.ensureWorkspaceState(workspace.id, workspace);
      if (!state.executionHostBinding || !executionHostBindingsEqual(state.executionHostBinding, workspace.executionHostBinding)) {
        throw new HarnessError("harness_connection_aborted", "The workspace execution host changed while preparing its operation.");
      }
      const settings = options.settings
        ? await this.buildRuntimeSettings(workspace.executionHostBinding, options.settings.agent)
        : state.settings;
      this.assertPendingExecutionHost(pending);
      const backend = areRuntimeServerSettingsEqual(state.settings, settings)
        ? await this.acquireWorkspaceBackend(workspace.id, state, options.directory)
        : null;
      this.assertPendingExecutionHost(pending);
      if (this.connections.get(workspace.id) !== state) {
        throw new HarnessError("harness_connection_aborted", "The workspace connection changed while preparing its operation.");
      }
      if (backend) {
        return await operation(backend);
      }
      return await this.withTemporaryBackend({
        workspaceId: workspace.id,
        localNodeId: state.localNodeId ?? null,
        executionHostBinding: workspace.executionHostBinding,
        userId,
        settings,
        directory: options.directory,
      }, operation);
    } finally {
      this.pendingExecutionHosts.delete(pending);
    }
  }

  private async acquireWorkspaceBackend(
    workspaceId: string,
    state: WorkspaceConnectionState,
    directory: string,
  ): Promise<Backend | null> {
    if (state.connection?.pending) {
      if (state.connection.directory !== directory) return null;
      await state.connection.pending;
    }
    if (state.connection?.controller.signal.aborted) return null;
    if (state.backend.isConnected()) {
      return state.backend.getDirectory() === directory ? state.backend : null;
    }
    if (state.connection) return null;
    const connection: NonNullable<WorkspaceConnectionState["connection"]> = {
      directory,
      controller: new AbortController(),
    };
    state.connection = connection;
    connection.pending = this.connectWorkspaceBackend(workspaceId, state, connection);
    try {
      await connection.pending;
      return state.backend;
    } finally {
      delete connection.pending;
    }
  }

  private async connectWorkspaceBackend(
    workspaceId: string,
    state: WorkspaceConnectionState,
    connection: NonNullable<WorkspaceConnectionState["connection"]>,
  ): Promise<void> {
    state.connectionError = null;
    try {
      await this.connectBackend(
        state.backend,
        buildConnectionConfig(state.settings, connection.directory),
        connection.controller,
      );
      if (this.connections.get(workspaceId) === state) {
        this.emitEvent({
          type: "server.connected",
          workspaceId,
          serverUrl: buildAgentServerUrl(state.settings),
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      state.connectionError = String(error);
      if (this.connections.get(workspaceId) === state) {
        this.emitEvent({
          type: "server.error",
          workspaceId,
          error: state.connectionError,
          timestamp: new Date().toISOString(),
        });
      }
      try {
        await this.disconnectBackend(state.backend);
        if (state.connection === connection) delete state.connection;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Workspace connection and cleanup failed.", { cause: error });
      }
      throw error;
    }
  }

  private async connectBackend(
    backend: Backend,
    config: BackendConnectionConfig,
    controller: AbortController,
  ): Promise<void> {
    const timeoutError = createAcpConnectionTimeoutError(this.connectionTimeoutMs, {
      transport: config.transport,
      target: config.transport === "ssh"
        ? {
            ...(config.hostname ? { hostname: config.hostname } : {}),
            ...(config.port === undefined ? {} : { port: config.port }),
            ...(config.username ? { username: config.username } : {}),
          }
        : undefined,
    });

    const timeoutId = setTimeout(() => controller.abort(timeoutError), this.connectionTimeoutMs);
    try {
      // Production backends are abort-aware and settle only after their
      // transport cleanup. A Promise.race here would return on timeout while
      // leaving a connection lifecycle running in the background.
      await backend.connect(config, controller.signal);
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async withTemporaryBackend<T>(
    context: WorkspaceBackendOptions & { userId: string; settings: RuntimeServerSettings; directory: string },
    operation: (backend: Backend) => Promise<T>,
  ): Promise<T> {
    const backend = this.createBackendForSettings(context.settings, context);
    const controller = new AbortController();
    const close = createRetryableAsyncOperation(async () => {
      const reason = controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason
        : undefined;
      controller.abort();
      await this.disconnectBackend(backend, reason);
      this.operationConnections.delete(backend);
    });
    this.operationConnections.set(backend, {
      userId: context.userId,
      workspaceId: context.workspaceId,
      executionHostBinding: structuredClone(context.executionHostBinding),
      controller,
      close,
    });
    await using connection = { backend, [Symbol.asyncDispose]: close };
    await this.connectBackend(
      connection.backend,
      buildConnectionConfig(context.settings, context.directory),
      controller,
    );
    return await operation(connection.backend);
  }

  private async closeWorkspaceBackend(
    workspaceId: string,
    state: WorkspaceConnectionState,
    reason?: Error,
  ): Promise<boolean> {
    state.connection?.controller.abort(reason);
    return await this.closeBackend(state.backend, workspaceId, reason);
  }

  /**
   * Reset connection for a specific workspace.
   * Disconnects the backend and clears the cached instance.
   * Used for recovery when connections become stale.
   */
  async resetWorkspaceConnection(workspaceId: string): Promise<void> {
    const errors: unknown[] = [];
    for (const pending of this.pendingExecutionHosts) {
      if (pending.workspaceId === workspaceId) pending.invalidated = true;
    }
    const state = this.connections.get(workspaceId);
    this.clearCommandExecutorsForWorkspace(workspaceId);

    if (state) {
      if (await this.closeWorkspaceBackend(workspaceId, state)) {
        if (this.connections.get(workspaceId) === state) this.connections.delete(workspaceId);
      } else {
        errors.push(new Error(`Failed to close workspace connection ${workspaceId}.`));
      }
    }
    try {
      await this.closeOperationConnections(
        [...this.operationConnections.values()].filter((connection) => connection.workspaceId === workspaceId),
      );
    } catch (error) {
      errors.push(error);
    }

    this.emitEvent({
      type: "server.reset",
      workspaceId,
      timestamp: new Date().toISOString(),
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to reset workspace connections.");
    }
  }

  /**
   * Retire affected cache entries before awaiting teardown. Existing task/chat
   * bindings, not mutable workspace settings, determine session ownership.
   */
  async invalidateMeshExecutionConnections(event: Exclude<MeshStateEvent, { impact: "inventory" }>): Promise<void> {
    const { userId, workerNodeIds } = event.scope;
    const matches = (state: { userId: string; executionHostBinding?: ExecutionHostBinding | null }): boolean =>
      state.userId === userId
      && state.executionHostBinding?.host.kind === "mesh"
      && workerNodeIds.includes(state.executionHostBinding.host.nodeId);
    const teardown: Promise<unknown>[] = [];
    const reason = new HarnessError(
      "harness_transport_closed",
      `The Mesh worker connection was invalidated (${event.reason}).`,
      { details: { reason: event.reason, workerNodeIds } },
    );
    for (const pending of this.pendingExecutionHosts) {
      if (matches(pending)) pending.invalidated = true;
    }
    for (const [key, cached] of this.commandExecutors) {
      if (matches(cached)) this.evictCommandExecutor(key);
    }
    for (const [workspaceId, state] of this.connections) {
      if (!matches(state)) continue;
      this.connections.delete(workspaceId);
      teardown.push(this.closeWorkspaceBackend(workspaceId, state, reason));
      this.emitEvent({ type: "server.reset", workspaceId, timestamp: new Date().toISOString() });
    }
    for (const connection of this.operationConnections.values()) {
      if (!matches(connection)) continue;
      connection.controller.abort(reason);
      teardown.push(connection.close());
    }
    if (event.impact === "resources") {
      for (const [contextId, state] of this.taskConnections) {
        if (!matches(state)) continue;
        teardown.push(this.disconnectTask(contextId, reason).then(() => {}));
      }
    }
    log.debug("Invalidating scoped Mesh execution resources", {
      userId, workerNodeIds, impact: event.impact, reason: event.reason,
    });
    await Promise.all(teardown);
  }

  private async closeOperationConnections(connections: OperationConnection[]): Promise<void> {
    const results = await Promise.allSettled(connections.map((connection) => connection.close()));
    const errors: unknown[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        log.error("Error closing helper connection", {
          contextId: connections[index]!.workspaceId,
          error: String(result.reason),
        });
        errors.push(result.reason);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close helper connections.");
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.unsubscribeMeshState?.();
    this.unsubscribeMeshState = undefined;
    await this.resetAllConnections();
  }

  /**
   * Reset all workspace connections.
   * Disconnects all backends and clears all cached instances.
   */
  async resetAllConnections(): Promise<void> {
    const errors: unknown[] = [];
    for (const pending of this.pendingExecutionHosts) {
      pending.invalidated = true;
    }
    // Reset all workspace-level connections
    for (const [workspaceId, state] of this.connections) {
      if (await this.closeWorkspaceBackend(workspaceId, state)) {
        if (this.connections.get(workspaceId) === state) this.connections.delete(workspaceId);
      } else {
        errors.push(new Error(`Failed to close workspace connection ${workspaceId}.`));
      }
    }
    try {
      await this.closeOperationConnections([...this.operationConnections.values()]);
    } catch (error) {
      errors.push(error);
    }

    // Reset all task-level connections
    for (const taskId of this.taskConnections.keys()) {
      const disconnected = await this.disconnectTask(taskId);
      if (!disconnected) {
        errors.push(new Error(`Failed to close task connection ${taskId}.`));
      }
    }

    this.clearAllCommandExecutors();
    this.invalidateLocalMeshNodeIdCache();

    this.emitEvent({
      type: "server.reset",
      timestamp: new Date().toISOString(),
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to reset backend connections.");
    }
  }

  /**
   * Test connection with provided settings (without updating workspace settings).
   * Returns true if connection succeeds, false otherwise.
   * Uses a timeout + AbortController to prevent indefinite hangs when the
   * remote server is unreachable.
   */
  async testConnection(
    settings: ServerSettings,
    directory: string,
    executionHost?: ExecutionHostRef,
    sshTarget?: WorkspaceSshTargetInput,
    bindingOverride?: ExecutionHostBinding,
  ): Promise<{ success: boolean; error?: string }> {
    const directSshTarget: SshConnectionTarget | undefined = sshTarget
      ? {
          host: sshTarget.host.trim(),
          port: sshTarget.port,
          username: sshTarget.username.trim(),
          ...(sshTarget.password ? { password: sshTarget.password } : {}),
        }
      : undefined;
    const binding = bindingOverride
      ?? (executionHost
        ? executionHostService.getBinding(executionHost)
        : undefined);
    if (!binding && !directSshTarget) {
      return { success: false, error: "An execution host or SSH target is required" };
    }
    const runtimeSettings = binding
      ? await this.buildRuntimeSettings(
          binding,
          settings.agent,
          undefined,
          directSshTarget,
        )
      : {
          agent: {
            ...settings.agent,
            transport: "ssh" as const,
            hostname: directSshTarget!.host,
            port: directSshTarget!.port,
            username: directSshTarget!.username,
            password: directSshTarget!.password,
          },
        };
    const localNodeId = await this.getLocalMeshNodeId();
    const backend = this.createBackendForSettings(
      runtimeSettings,
      binding && executionHost?.kind !== "ssh"
        ? {
            workspaceId: crypto.randomUUID(),
            localNodeId,
            executionHostBinding: binding,
          }
        : undefined,
    );
    const config = buildConnectionConfig(runtimeSettings, directory);
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Connection timed out after ${this.connectionTimeoutMs}ms`)),
          this.connectionTimeoutMs,
        );
      });

      await Promise.race([
        backend.connect(config, abortController.signal),
        timeoutPromise,
      ]);

      await backend.disconnect();
      return { success: true };
    } catch (error) {
      abortController.abort();
      try {
        await backend.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
      return { success: false, error: String(error) };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate that a directory exists and report whether it is a git repository.
   * Workspace creation decides whether the reported Git capability is required.
   *
   * @param settings - Server settings to use for connection
   * @param directory - The directory to validate
   * @returns Object with success flag, isGitRepo boolean, directoryExists boolean, and optional error message
   */
  async validateRemoteDirectory(
    settings: ServerSettings,
    directory: string,
    executionHost?: ExecutionHostRef,
    sshTarget?: WorkspaceSshTargetInput,
    bindingOverride?: ExecutionHostBinding,
  ): Promise<{ success: boolean; isGitRepo?: boolean; directoryExists?: boolean; error?: string }> {
    log.debug("Validating remote directory", {
      directory,
      provider: settings.agent.provider,
      transport: sshTarget ? "ssh" : executionHost?.kind,
    });

    try {
      const binding = bindingOverride
        ?? (executionHost
          ? executionHostService.getBinding(executionHost)
          : undefined);
      const executor = sshTarget
        ? await executionHostService.getCommandExecutorForSshTarget(
            {
              host: sshTarget.host.trim(),
              port: sshTarget.port,
              username: sshTarget.username.trim(),
              ...(sshTarget.password ? { password: sshTarget.password } : {}),
            },
            {
              operationId: `validate-directory:${sshTarget.host}:${String(sshTarget.port)}`,
              directory,
            },
          )
        : binding
          ? await executionHostService.getCommandExecutor(
              binding,
              {
                operationId: `validate-directory:${binding.targetKey}`,
                directory,
                provider: settings.agent.provider,
              },
            )
          : null;
      if (!executor) {
        return { success: false, error: "An execution host or SSH target is required" };
      }

      if (executionHost?.kind === "ssh" || sshTarget) {
        const connectivityProbe = await executor.exec("true", [], { cwd: "/" });
        if (!connectivityProbe.success) {
          const detail = connectivityProbe.stderr || connectivityProbe.stdout || `exit code ${connectivityProbe.exitCode}`;
          return {
            success: false,
            error: `Failed to connect to remote server: ${detail}`,
          };
        }

      }

      const executionDirectory = await resolveCommandExecutorDirectory(
        executor,
        directory,
      );
      const directoryExists = await executor.directoryExists(executionDirectory);
      if (!directoryExists) {
        log.debug("Directory does not exist on execution target", { directory });
        return { success: true, directoryExists: false, isGitRepo: false };
      }

      const git = GitService.withExecutor(executor);
      const isGitRepo = await git.isGitRepo(directory);
      return { success: true, directoryExists: true, isGitRepo };
    } catch (error) {
      log.error("Failed to validate remote directory", { directory, error: String(error) });
      return { success: false, error: String(error) };
    }
  }

  async createCommandExecutorForExecutionHost(
    settings: ServerSettings,
    directory: string,
    executionHost: ExecutionHostRef,
  ): Promise<CommandExecutor> {
    const binding = executionHostService.getBinding(executionHost);
    return await executionHostService.getCommandExecutor(
      binding,
      {
        operationId: crypto.randomUUID(),
        directory,
        provider: settings.agent.provider,
      },
    );
  }

  /**
   * Get connection status for a specific workspace.
   */
  async getWorkspaceStatus(workspaceId: string): Promise<import("@/shared/settings").ConnectionStatus> {
    const workspace = await getWorkspace(workspaceId);
    const state = this.connections.get(workspaceId);
    const provider = workspace?.serverSettings.agent.provider
      ?? getDefaultRuntimeServerSettings().agent.provider;
    const status: import("@/shared/settings").ConnectionStatus = {
      connected: state?.backend.isConnected() ?? false,
      provider,
      adapter: workspace?.serverSettings.agent.adapter ?? "acp",
      transport: workspace?.executionHostBinding.host.kind ?? "local",
      capabilities: state ? this.getAgentCapabilities(state.settings) : [],
      serverUrl: state ? buildAgentServerUrl(state.settings) : undefined,
      error: state?.connectionError ?? undefined,
    };

    if (!workspace) {
      status.connected = false;
      status.error = "Workspace not found";
      return status;
    }

    const host = workspace.executionHostBinding.host;
    if (host.kind === "local") {
      status.executionAvailability = "local";
    } else if (host.kind === "mesh") {
      const localNodeId = await this.getLocalMeshNodeId();
      const registration = await getWorkerRegistration(host.nodeId, requireExecutionOwnerUserId());
      status.executionAvailability = (
        host.nodeId !== localNodeId
        && registration?.grantStatus === "active"
        && Boolean(registration.workerEndpoint)
      )
        ? "remote-connected"
        : "remote-unavailable";
    } else {
      status.executionAvailability = "local";
    }

    try {
      const executor = await this.getCommandExecutorAsync(workspaceId, workspace.directory);
      const executionDirectory = await resolveCommandExecutorDirectory(
        executor,
        workspace.directory,
      );
      const directoryExists = await executor.directoryExists(executionDirectory);
      let isGitRepo = false;
      if (directoryExists) {
        const git = GitService.withExecutor(executor);
        isGitRepo = await git.isGitRepo(workspace.directory);
      }
      status.directoryExists = directoryExists;
      status.isGitRepo = isGitRepo;
      status.connected = status.connected && directoryExists;
    } catch (error) {
      status.connected = false;
      if (status.executionAvailability === "remote-connected") {
        status.executionAvailability = "remote-unavailable";
      }
      status.error = state?.connectionError ?? String(error);
    }

    return status;
  }

  /**
   * Get server settings for a workspace.
   *
   * @param workspaceId - The workspace ID
   * @returns The server settings for the workspace
   * @throws Error if workspace not found
   */
  async getWorkspaceSettings(workspaceId: string): Promise<RuntimeServerSettings> {
    this.assertAcceptingConnections();
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return await this.buildRuntimeSettings(
      workspace.executionHostBinding,
      workspace.serverSettings.agent,
    );
  }

  /**
   * Get the backend instance for a workspace, hydrating persisted settings first.
   */
  async getBackendAsync(workspaceId: string): Promise<Backend> {
    const state = await this.ensureWorkspaceState(workspaceId);
    return state.backend;
  }

  /**
   * Get a dedicated backend instance for a task.
   * Each task gets its own AcpBackend so that concurrent tasks
   * in the same workspace don't interfere with each other.
   *
   * The actual directory binding happens later when TaskEngine calls
   * backend.connect() in setupSession() with the worktree directory.
   *
   * @param taskId - The task ID
   * @param workspaceId - The workspace ID (for settings lookup)
   * @returns A Backend instance dedicated to this task
   */
  getTaskBackend(taskId: string, workspaceId: string): Backend {
    this.assertAcceptingConnections();
    if (this.taskDisconnects.has(taskId)) {
      throw new Error(`[BackendManager] Backend teardown is still in progress for context ${taskId}.`);
    }
    const existing = this.taskConnections.get(taskId);
    if (existing) {
      if (existing.userId !== requireExecutionOwnerUserId() || existing.workspaceId !== workspaceId) {
        throw new HarnessError("harness_session_not_owned", "The backend belongs to a different task or chat context.");
      }
      return existing.backend;
    }

    // Create a new dedicated backend for this task
    const workspaceState = this.connections.get(workspaceId);
    if (!workspaceState) {
      throw new Error(
        `[BackendManager] Workspace ${workspaceId} not initialized. Use getBackendAsync() first.`,
      );
    }
    if (workspaceState.userId !== requireExecutionOwnerUserId()) {
      throw new HarnessError("harness_session_not_owned", "The workspace backend belongs to a different user.");
    }
    if (!workspaceState.executionHostBinding) {
      throw new Error(`[BackendManager] Workspace ${workspaceId} has no execution-host binding.`);
    }
    const backend = this.createBackendForSettings(workspaceState.settings, {
      workspaceId,
      localNodeId: workspaceState.localNodeId ?? null,
      executionHostBinding: workspaceState.executionHostBinding,
    });
    this.taskConnections.set(taskId, {
      userId: workspaceState.userId,
      backend,
      workspaceId,
      settings: structuredClone(workspaceState.settings),
      executionHostBinding: structuredClone(workspaceState.executionHostBinding),
    });
    log.debug(`[BackendManager] Created dedicated backend for task ${taskId}`);
    return backend;
  }

  /**
   * Get a dedicated backend instance for a chat.
   * Chats share the same dedicated-backend pool semantics as tasks.
   */
  getChatBackend(chatId: string, workspaceId: string): Backend {
    return this.getTaskBackend(chatId, workspaceId);
  }

  getInitializedContextBackend(contextId: string): Backend | null {
    const state = this.taskConnections.get(contextId);
    if (state && state.userId !== requireExecutionOwnerUserId()) {
      throw new HarnessError("harness_session_not_owned", "The backend belongs to a different user.");
    }
    return state?.backend ?? null;
  }

  /**
   * Disconnect and clean up the backend for a specific task.
   * Called when a task is stopped, completed, or failed.
   *
   * @param taskId - The task ID to clean up
   */
  async disconnectTask(taskId: string, reason?: Error): Promise<boolean> {
    const pending = this.taskDisconnects.get(taskId);
    if (pending) {
      if (!reason) {
        return await pending.promise;
      }

      this.retireTaskConnection(taskId, pending.state);
      try {
        pending.state.backend.abortAllSubscriptions(reason);
      } catch (error) {
        log.error("[BackendManager] Error aborting invalidated task subscriptions", {
          contextId: taskId,
          error: String(error),
        });
      }
      return await pending.promise;
    }

    const state = this.taskConnections.get(taskId);
    if (!state) {
      return true;
    }

    let resolveDisconnect!: (succeeded: boolean) => void;
    const disconnect = new Promise<boolean>((resolve) => {
      resolveDisconnect = resolve;
    });
    const pendingDisconnect = { state, promise: disconnect };
    this.taskDisconnects.set(taskId, pendingDisconnect);
    if (reason) {
      this.retireTaskConnection(taskId, state);
    }

    try {
      const succeeded = await this.closeBackend(state.backend, taskId, reason);
      resolveDisconnect(succeeded);
      if (succeeded) {
        this.retireTaskConnection(taskId, state);
      }
      if (succeeded) {
        log.debug(`[BackendManager] Cleaned up backend for task ${taskId}`);
      }
      return succeeded;
    } catch (error) {
      log.error("[BackendManager] Error closing backend", { contextId: taskId, error: String(error) });
      resolveDisconnect(false);
      return false;
    } finally {
      if (this.taskDisconnects.get(taskId) === pendingDisconnect) {
        this.taskDisconnects.delete(taskId);
      }
    }
  }

  private retireTaskConnection(taskId: string, state: TaskConnectionState): void {
    if (this.taskConnections.get(taskId) === state) {
      this.taskConnections.delete(taskId);
    }
  }

  private async closeBackend(backend: Backend, contextId: string, reason?: Error): Promise<boolean> {
    try {
      await this.disconnectBackend(backend, reason);
      return true;
    } catch (error) {
      log.error("[BackendManager] Error closing backend", { contextId, error: String(error) });
      return false;
    }
  }

  private async disconnectBackend(backend: Backend, reason?: Error): Promise<void> {
    await using connection = { backend, [Symbol.asyncDispose]: async () => await backend.disconnect() };
    await harnessActivityService.closeBackend(backend);
    connection.backend.abortAllSubscriptions(reason);
  }

  /**
   * Disconnect and clean up the backend for a specific chat.
   */
  async disconnectChat(chatId: string): Promise<boolean> {
    return await this.disconnectTask(chatId);
  }

  /**
   * Get a CommandExecutor for running deterministic commands/files via execution settings.
   */
  async getCommandExecutor(workspaceId: string, directory?: string): Promise<CommandExecutor> {
    const state = this.connections.get(workspaceId);
    if (!state) {
      throw new Error(`[BackendManager] Workspace ${workspaceId} not initialized`);
    }

    const dir = directory ?? state.backend.getDirectory();
    const cacheKey = this.buildCommandExecutorCacheKey(workspaceId, dir, state.settings);
    const capabilitySnapshot = state.executionHostBinding?.host.kind === "mesh"
      ? JSON.stringify(executionHostService.validateBinding(state.executionHostBinding, state.userId).runtime.capabilities)
      : null;
    const cachedExecutor = this.commandExecutors.get(cacheKey);
    if (cachedExecutor) {
      if (cachedExecutor.capabilitySnapshot === capabilitySnapshot) {
        return cachedExecutor.executor;
      }
      this.evictCommandExecutor(cacheKey);
    }

    const execution = deriveExecutionSettings(state.settings);
    const commandExecutorLogContext: Record<string, string | number> = {
      directory: dir,
      executionProvider: execution.provider,
      ...(execution.sshTarget?.host ? { host: execution.sshTarget.host } : {}),
      ...(typeof execution.sshTarget?.port === "number" ? { port: execution.sshTarget.port } : {}),
      ...(execution.sshTarget?.username ? { user: execution.sshTarget.username } : {}),
    };
    log.debug(`[BackendManager] Creating CommandExecutor for workspace ${workspaceId}`, commandExecutorLogContext);
    const commandContext = {
      operationId: workspaceId,
      directory: dir,
      provider: state.settings.agent.provider,
      localUserId: requireExecutionOwnerUserId(),
      sshTargetOverride: execution.sshTarget,
    };
    if (!state.executionHostBinding) {
      throw new Error(`Workspace ${workspaceId} has no execution-host binding`);
    }
    const executor = await executionHostService.getCommandExecutor(
      state.executionHostBinding,
      commandContext,
    );
    if (this.connections.get(workspaceId) !== state) {
      closeCommandExecutor(executor);
      throw new HarnessError("harness_connection_aborted", "The workspace execution host changed while creating its command executor.");
    }
    const concurrent = this.commandExecutors.get(cacheKey);
    if (concurrent) {
      if (concurrent.capabilitySnapshot === capabilitySnapshot) {
        closeCommandExecutor(executor);
        return concurrent.executor;
      }
      this.evictCommandExecutor(cacheKey);
    }
    this.commandExecutors.set(cacheKey, {
      executor, workspaceId, userId: state.userId,
      executionHostBinding: structuredClone(state.executionHostBinding),
      capabilitySnapshot,
    });
    return executor;
  }

  /**
   * Get a CommandExecutor for running commands/files via execution settings.
   */
  async getCommandExecutorAsync(workspaceId: string, directory: string): Promise<CommandExecutor> {
    await this.ensureWorkspaceState(workspaceId);

    return await this.getCommandExecutor(workspaceId, directory);
  }

  async withExecutionHostBackend<T>(
    context: {
      binding: ExecutionHostBinding;
      provider: AgentProvider;
      directory: string;
      sshPassword?: string;
    },
    operation: (backend: Backend, settings: RuntimeServerSettings) => Promise<T>,
  ): Promise<T> {
    const userId = requireExecutionOwnerUserId();
    const pending = this.trackPendingExecutionHost(userId, context.binding);
    try {
      const settings = await this.buildRuntimeSettings(
        context.binding,
        createAgentSettings("acp", context.provider),
        context.sshPassword,
      );
      const localNodeId = await this.getLocalMeshNodeId();
      this.assertPendingExecutionHost(pending);
      return await this.withTemporaryBackend({
        workspaceId: `execution-host:${crypto.randomUUID()}`,
        localNodeId,
        executionHostBinding: context.binding,
        settings,
        userId,
        directory: context.directory,
      }, async (backend) => await operation(backend, settings));
    } finally {
      this.pendingExecutionHosts.delete(pending);
    }
  }

  async getConnectedExecutionHostBackend(context: {
    connectionId: string;
    binding: ExecutionHostBinding;
    provider: AgentProvider;
    directory: string;
    sshPassword?: string;
  }): Promise<Backend | null> {
    this.assertAcceptingConnections();
    const state = this.taskConnections.get(context.connectionId);
    if (!state) return null;
    if (state.userId !== requireExecutionOwnerUserId()) {
      throw new HarnessError("harness_session_not_owned", "The backend belongs to a different user.");
    }
    if (
      state.workspaceId !== ""
      || !executionHostBindingsEqual(state.executionHostBinding, context.binding)
      || !state.backend.isConnected()
      || state.backend.getDirectory() !== context.directory
    ) {
      return null;
    }
    const settings = await this.buildRuntimeSettings(
      context.binding,
      createAgentSettings("acp", context.provider),
      context.sshPassword ?? (state.settings.agent.transport === "ssh" ? state.settings.agent.password : undefined),
    );
    return this.taskConnections.get(context.connectionId) === state
      && state.backend.isConnected()
      && areRuntimeServerSettingsEqual(state.settings, settings)
      ? state.backend
      : null;
  }

  async createBackendForExecutionHost(
    connectionId: string,
    binding: ExecutionHostBinding,
    provider: AgentProvider,
    sshPassword?: string,
  ): Promise<{ backend: Backend; settings: RuntimeServerSettings }> {
    const userId = requireExecutionOwnerUserId();
    const pending = this.trackPendingExecutionHost(userId, binding);
    try {
      const settings = await this.buildRuntimeSettings(binding, createAgentSettings("acp", provider), sshPassword);
      const localNodeId = await this.getLocalMeshNodeId();
      this.assertPendingExecutionHost(pending);
      const options: WorkspaceBackendOptions = {
        workspaceId: connectionId, localNodeId, executionHostBinding: binding,
      };
      const existing = this.taskConnections.get(connectionId);
      if (existing && (existing.userId !== userId || existing.workspaceId !== "")) {
        throw new HarnessError("harness_session_not_owned", "The backend belongs to a different task or chat context.");
      }
      const backend = this.createBackendForSettings(settings, options);
      this.taskConnections.set(connectionId, {
        userId, backend, workspaceId: "", settings: structuredClone(settings),
        executionHostBinding: structuredClone(binding),
      });
      if (existing) await this.closeBackend(existing.backend, connectionId);
      if (pending.invalidated || this.taskConnections.get(connectionId)?.backend !== backend) {
        if (this.taskConnections.get(connectionId)?.backend === backend) {
          this.taskConnections.delete(connectionId);
          await this.closeBackend(backend, connectionId);
        }
        throw new HarnessError("harness_connection_aborted", "The execution host changed while replacing its connection.");
      }
      return { backend, settings };
    } finally {
      this.pendingExecutionHosts.delete(pending);
    }
  }

  /**
   * Emit a server event.
   */
  private emitEvent(event: ServerEvent): void {
    // Cast to TaskEvent since the emitter accepts that type
    // The WebSocket handler will pass through any event with a type property
    taskEventEmitter.emit(event as unknown as TaskEvent);
  }
}

/**
 * Global backend manager singleton.
 */
export const backendManager = new BackendManager();
