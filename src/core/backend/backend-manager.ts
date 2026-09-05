/**
 * Backend manager for Clanky Tasks Management System.
 * Manages multiple workspace-specific backend connections.
 *
 * Each workspace can have its own server settings and connection,
 * allowing parallel operation of tasks across different workspaces.
 */

import {
  AcpBackend,
  WorkspaceAcpTransportLifecycle,
  createAcpConnectionTimeoutError,
} from "../../backends/acp";
import type { Backend } from "../../backends/types";
import { getWorkspace } from "../../persistence/workspaces";
import {
  getDefaultRuntimeServerSettings,
  type RuntimeServerSettings,
  type ServerSettings,
} from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { taskEventEmitter } from "../event-emitter";
import type { TaskEvent } from "@/shared/events";
import type { CommandExecutor } from "../command-executor";
import { GitService } from "../git";
import { log } from "@pablozaiden/webapp/server";
import { buildConnectionConfig } from "./backend-connection-pool";
import {
  deriveExecutionSettings,
  buildAgentServerUrl,
  type WorkspaceConnectionState,
  type TaskConnectionState,
  type ServerEvent,
} from "./backend-state";
import type { CommandExecutorFactory } from "./backend-executor-factory";
import { ensureLocalMeshNodeIdentity } from "../../persistence/mesh-node-identity";
import { getWorkerRegistration } from "../../persistence/mesh";
import { requireCurrentUserId } from "../user-context";
import { meshAcpGateway } from "../mesh-acp-gateway";
import { getSshReliabilityPolicy } from "../ssh-reliability-policy";
import { executionHostService } from "../execution-host-service";
import { executionHostBindingsEqual } from "@/shared/execution-host";
import type {
  ExecutionHostBinding,
  ExecutionHostRef,
} from "@/shared/execution-host";
import type { AgentProvider } from "@/shared/settings";
import { getSshServerConfig } from "../../persistence/ssh-servers";

interface WorkspaceBackendOptions {
  workspaceId: string;
  localNodeId: string | null;
  executionHostBinding: ExecutionHostBinding;
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
  /** Map of workspace execution key to command executor. */
  private commandExecutors = new Map<string, CommandExecutor>();
  private initialized = false;
  /** Custom executor factory for testing */
  private testExecutorFactory: CommandExecutorFactory | null = null;
  /** Flag to indicate a test backend is being used (should be preserved on reset) */
  private isTestBackend = false;
  /** Test backend instance (when isTestBackend is true) */
  private testBackend: Backend | null = null;
  /** Test settings (when isTestBackend is true) */
  private testSettings: RuntimeServerSettings = getDefaultRuntimeServerSettings();
  /** Overridable connection timeout (ms) for testing. Defaults to the SSH reliability policy. */
  private connectionTimeoutMs: number = getSshReliabilityPolicy().connectionTimeoutMs;
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
    provider: AgentProvider,
    sshPassword?: string,
  ): Promise<RuntimeServerSettings> {
    executionHostService.validateBinding(binding);
    if (binding.host.kind !== "ssh") {
      return {
        agent: {
          provider,
          transport: "stdio",
        },
      };
    }
    const server = await getSshServerConfig(binding.host.serverId);
    if (!server) {
      throw new Error(`SSH server not found: ${binding.host.serverId}`);
    }
    return {
      agent: {
        provider,
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
    const transportLifecycleFactory = workspaceOptions && settings.agent.transport === "stdio"
      ? () => new WorkspaceAcpTransportLifecycle({
          workspaceId: workspaceOptions.workspaceId,
          localNodeId: workspaceOptions.localNodeId ?? "",
          executionNodeId: workspaceOptions.executionHostBinding.host.kind === "ssh"
            ? null
            : workspaceOptions.executionHostBinding.host.nodeId,
        })
      : undefined;
    switch (settings.agent.provider) {
      case "opencode":
      case "copilot":
        // Both providers use the same backend implementation for now.
        return new AcpBackend({ transportLifecycleFactory });
      default:
        return new AcpBackend({ transportLifecycleFactory });
    }
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
  private async ensureWorkspaceState(workspaceId: string): Promise<WorkspaceConnectionState> {
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const settings = await this.buildRuntimeSettings(
      workspace.executionHostBinding,
      workspace.serverSettings.agent.provider,
    );
    const workspaceOptions = await this.getWorkspaceBackendOptions(workspace);
    let state = this.connections.get(workspaceId);
    if (!state) {
      state = {
        backend: this.createBackendForSettings(settings, {
          ...workspaceOptions,
        }),
        settings,
        connectionError: null,
        localNodeId: workspaceOptions.localNodeId,
        executionHostBinding: workspaceOptions.executionHostBinding,
      };
      this.connections.set(workspaceId, state);
      return state;
    }

    if (
      state.settings.agent.provider !== settings.agent.provider
      || !state.executionHostBinding
      || !executionHostBindingsEqual(
        state.executionHostBinding,
        workspaceOptions.executionHostBinding,
      )
    ) {
      const previousBackend = state.backend;
      if (previousBackend.isConnected()) {
        await previousBackend.disconnect();
      }
      state.backend = this.createBackendForSettings(settings, {
        ...workspaceOptions,
      });
      state.connectionError = null;
      this.clearCommandExecutorsForWorkspace(workspaceId);
    }

    if (JSON.stringify(state.settings) !== JSON.stringify(settings)) {
      this.clearCommandExecutorsForWorkspace(workspaceId);
    }
    state.settings = settings;
    state.localNodeId = workspaceOptions.localNodeId;
    state.executionHostBinding = workspaceOptions.executionHostBinding;
    return state;
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
    const keyPrefix = `{"workspaceId":"${workspaceId}"`;
    for (const key of this.commandExecutors.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.commandExecutors.delete(key);
      }
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
  }

  /**
   * Connect to the backend for a specific workspace.
   * Uses the workspace's server settings for the connection.
   *
   * @param workspaceId - The workspace ID to connect for
   * @param directory - The working directory for the connection
   */
  async connect(workspaceId: string, directory: string): Promise<void> {
    // If using test backend, use that instead
    if (this.isTestBackend && this.testBackend) {
      return this.connectWithTestBackend(workspaceId, directory);
    }

    const state = await this.ensureWorkspaceState(workspaceId);
    const settings = state.settings;

    // If already connected, disconnect first
    if (state.backend.isConnected()) {
      await state.backend.disconnect();
    }

    state.connectionError = null;

    const config = buildConnectionConfig(settings, directory);

    // Use a timeout + AbortController to prevent indefinite hangs when the
    // remote server is unreachable (connectToExisting disables Bun's request timeout).
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
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

    try {
      timeoutId = setTimeout(
        () => abortController.abort(timeoutError),
        this.connectionTimeoutMs,
      );
      // Production backends are abort-aware and settle only after their
      // transport cleanup. A Promise.race here would return on timeout while
      // leaving a connection lifecycle running in the background.
      await state.backend.connect(config, abortController.signal);

      this.emitEvent({
        type: "server.connected",
        workspaceId,
        mode: config.mode,
        serverUrl: buildAgentServerUrl(settings),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      abortController.abort();
      state.connectionError = String(error);
      this.emitEvent({
        type: "server.error",
        workspaceId,
        error: state.connectionError,
        timestamp: new Date().toISOString(),
      });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Connect using the test backend (for testing purposes).
   */
  private async connectWithTestBackend(workspaceId: string, directory: string): Promise<void> {
    if (!this.testBackend) {
      throw new Error("Test backend not set");
    }

    // Create connection state with test backend
    let state = this.connections.get(workspaceId);
    if (!state) {
      state = {
        backend: this.testBackend,
        settings: this.testSettings,
        connectionError: null,
      };
      this.connections.set(workspaceId, state);
    }

    // If not connected, connect
    if (!state.backend.isConnected()) {
      const config = buildConnectionConfig(state.settings, directory);
      await state.backend.connect(config);
    }

    this.emitEvent({
      type: "server.connected",
      workspaceId,
      mode: buildConnectionConfig(state.settings, directory).mode,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Disconnect from the backend for a specific workspace.
   */
  async disconnectWorkspace(workspaceId: string): Promise<void> {
    const state = this.connections.get(workspaceId);
    if (state && state.backend.isConnected()) {
      await state.backend.disconnect();
      this.emitEvent({
        type: "server.disconnected",
        workspaceId,
        timestamp: new Date().toISOString(),
      });
    }
    if (state) {
      state.connectionError = null;
    }
    this.clearCommandExecutorsForWorkspace(workspaceId);
  }

  /**
   * Reset connection for a specific workspace.
   * Disconnects the backend and clears the cached instance.
   * Used for recovery when connections become stale.
   */
  async resetWorkspaceConnection(workspaceId: string): Promise<void> {
    const state = this.connections.get(workspaceId);
    this.clearCommandExecutorsForWorkspace(workspaceId);

    if (state) {
      // Abort all active subscriptions first
      state.backend.abortAllSubscriptions();

      // If using test backend, preserve it
      if (this.isTestBackend) {
        state.connectionError = null;
        this.emitEvent({
          type: "server.reset",
          workspaceId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Disconnect cleanly
      if (state.backend.isConnected()) {
        await state.backend.disconnect();
      }

      // Remove from connections map
      this.connections.delete(workspaceId);
    }

    this.emitEvent({
      type: "server.reset",
      workspaceId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Invalidate only mesh-owned stdio execution resources. SSH connections are
   * intentionally left untouched when mesh membership or transport state changes.
   */
  async invalidateMeshExecutionConnections(): Promise<void> {
    await meshAcpGateway.closeAll();
    const { meshTerminalGateway } = await import("../mesh-terminal-gateway");
    const { closeAllMeshTerminalConnections } = await import("../terminal");
    await meshTerminalGateway.closeAll();
    await closeAllMeshTerminalConnections();
    const localNodeId = await this.getLocalMeshNodeId();

    for (const [workspaceId, state] of this.connections) {
      const host = state.executionHostBinding?.host;
      if (
        host?.kind !== "mesh"
        || host.nodeId === state.localNodeId
      ) {
        continue;
      }
      await this.resetWorkspaceConnection(workspaceId);
    }
    for (const [taskId, state] of this.taskConnections) {
      const workspace = await getWorkspace(state.workspaceId);
      if (
        workspace?.executionHostBinding.host.kind !== "mesh"
        || workspace.executionHostBinding.host.nodeId === localNodeId
      ) {
        continue;
      }
      await this.disconnectTask(taskId);
    }
    for (const key of this.commandExecutors.keys()) {
      try {
        const parsed = JSON.parse(key) as {
          executionHostBinding?: ExecutionHostBinding | null;
        };
        const host = parsed.executionHostBinding?.host;
        if (host?.kind === "mesh" && host.nodeId !== localNodeId) {
          const executor = this.commandExecutors.get(key);
          if (executor && "close" in executor && typeof executor.close === "function") {
            (executor as CommandExecutor & { close: () => void }).close();
          }
          this.commandExecutors.delete(key);
        }
      } catch {
        this.commandExecutors.delete(key);
      }
    }
  }

  /**
   * Reset all workspace connections.
   * Disconnects all backends and clears all cached instances.
   */
  async resetAllConnections(): Promise<void> {
    // Reset all workspace-level connections
    for (const [workspaceId, state] of this.connections) {
      try {
        state.backend.abortAllSubscriptions();
        if (state.backend.isConnected()) {
          await state.backend.disconnect();
        }
      } catch (error) {
        log.error(`Error resetting connection for workspace ${workspaceId}: ${String(error)}`);
      }
    }

    // Reset all task-level connections
    for (const [taskId, state] of this.taskConnections) {
      try {
        state.backend.abortAllSubscriptions();
        if (state.backend.isConnected()) {
          await state.backend.disconnect();
        }
      } catch (error) {
        log.error(`Error resetting task connection for ${taskId}: ${String(error)}`);
      }
    }

    // If not using test backend, clear all connections
    if (!this.isTestBackend) {
      this.connections.clear();
      this.taskConnections.clear();
    }
    this.commandExecutors.clear();
    this.invalidateLocalMeshNodeIdCache();

    this.emitEvent({
      type: "server.reset",
      timestamp: new Date().toISOString(),
    });
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
    executionHost: ExecutionHostRef,
  ): Promise<{ success: boolean; error?: string }> {
    const binding = executionHostService.getBinding(executionHost);
    const runtimeSettings = await this.buildRuntimeSettings(
      binding,
      settings.agent.provider,
    );
    const localNodeId = await this.getLocalMeshNodeId();
    // Reuse the configured test backend when present so tests can stub connection behavior.
    const testBackend = this.isTestBackend && this.testBackend
      ? this.testBackend
      : this.createBackendForSettings(runtimeSettings, executionHost.kind !== "ssh"
        ? {
            workspaceId: crypto.randomUUID(),
            localNodeId,
            executionHostBinding: binding,
          }
        : undefined);
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
        testBackend.connect(config, abortController.signal),
        timeoutPromise,
      ]);

      await testBackend.disconnect();
      return { success: true };
    } catch (error) {
      abortController.abort();
      try {
        await testBackend.disconnect();
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
    executionHost: ExecutionHostRef,
  ): Promise<{ success: boolean; isGitRepo?: boolean; directoryExists?: boolean; error?: string }> {
    log.debug("Validating remote directory", {
      directory,
      provider: settings.agent.provider,
      transport: executionHost.kind,
    });

    // In test mode, use the test executor factory if available
    if (this.testExecutorFactory) {
      log.debug("Using test executor factory for directory validation");
      const executor = this.testExecutorFactory(directory);

      // First check if directory exists
      const directoryExists = await executor.directoryExists(directory);
      if (!directoryExists) {
        log.debug("Directory does not exist on remote server", { directory });
        return { success: true, directoryExists: false, isGitRepo: false };
      }

      const git = GitService.withExecutor(executor);
      const isGitRepo = await git.isGitRepo(directory);
      return { success: true, directoryExists: true, isGitRepo };
    }

    try {
      const binding = executionHostService.getBinding(executionHost);
      const executor = await executionHostService.getCommandExecutor(
        binding,
        {
          operationId: `validate-directory:${binding.targetKey}`,
          directory,
          provider: settings.agent.provider,
        },
      );

      if (executionHost.kind === "ssh") {
        const connectivityProbe = await executor.exec("true", [], { cwd: "/" });
        if (!connectivityProbe.success) {
          const detail = connectivityProbe.stderr || connectivityProbe.stdout || `exit code ${connectivityProbe.exitCode}`;
          return {
            success: false,
            error: `Failed to connect to remote server: ${detail}`,
          };
        }

      }

      const directoryExists = await executor.directoryExists(directory);
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
    if (this.testExecutorFactory) {
      return this.testExecutorFactory(directory);
    }
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
      const registration = await getWorkerRegistration(host.nodeId, requireCurrentUserId());
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
      const directoryExists = await executor.directoryExists(workspace.directory);
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
   * In test mode (when setBackendForTesting was called), returns test settings.
   * In production, fetches the workspace from the database.
   *
   * @param workspaceId - The workspace ID
   * @returns The server settings for the workspace
   * @throws Error if workspace not found (in non-test mode)
   */
  async getWorkspaceSettings(workspaceId: string): Promise<RuntimeServerSettings> {
    // In test mode, return test settings
    if (this.isTestBackend) {
      return this.testSettings;
    }

    // In production, fetch from database
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return await this.buildRuntimeSettings(
      workspace.executionHostBinding,
      workspace.serverSettings.agent.provider,
    );
  }

  /**
   * Get an already-initialized backend instance for a workspace
   * (workspace-level operations only).
   *
   * Used for operations that don't belong to a specific task (name generation,
   * model listing, directory validation) when the workspace state is already
   * initialized.
   *
   * IMPORTANT: Do NOT use this for task execution. Use getTaskBackend() instead.
   *
   * @throws Error if workspace state has not been initialized yet.
   *         Use getBackendAsync() or connect() to hydrate it first.
   */
  getBackend(workspaceId: string): Backend {
    // Use test backend if set
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }

    const state = this.connections.get(workspaceId);
    if (state) {
      return state.backend;
    }

    throw new Error(`[BackendManager] Workspace ${workspaceId} not initialized. Use getBackendAsync() or connect() first.`);
  }

  /**
   * Get the cached backend instance for a workspace if it has already been initialized.
   * Does not hydrate workspace state from persistence.
   */
  getInitializedBackend(workspaceId: string): Backend | null {
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }

    return this.connections.get(workspaceId)?.backend ?? null;
  }

  /**
   * Get the backend instance for a workspace, hydrating persisted settings first.
   */
  async getBackendAsync(workspaceId: string): Promise<Backend> {
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }

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
   * In test mode, returns the shared test backend (tests manage their own isolation).
   *
   * @param taskId - The task ID
   * @param workspaceId - The workspace ID (for settings lookup)
   * @returns A Backend instance dedicated to this task
   */
  getTaskBackend(taskId: string, workspaceId: string): Backend {
    // Use test backend if set (tests share a single mock backend)
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }

    const existing = this.taskConnections.get(taskId);
    if (existing) {
      return existing.backend;
    }

    // Create a new dedicated backend for this task
    const workspaceState = this.connections.get(workspaceId);
    if (!workspaceState) {
      throw new Error(
        `[BackendManager] Workspace ${workspaceId} not initialized. Use getBackendAsync() or connect() first.`,
      );
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
      backend,
      workspaceId,
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

  getInitializedChatBackend(chatId: string): Backend | null {
    return this.taskConnections.get(chatId)?.backend ?? null;
  }

  /**
   * Disconnect and clean up the backend for a specific task.
   * Called when a task is stopped, completed, or failed.
   *
   * @param taskId - The task ID to clean up
   */
  async disconnectTask(taskId: string): Promise<void> {
    // In test mode, don't disconnect the shared test backend
    if (this.isTestBackend) {
      return;
    }

    const state = this.taskConnections.get(taskId);
    if (!state) {
      return;
    }

    try {
      state.backend.abortAllSubscriptions();
      if (state.backend.isConnected()) {
        await state.backend.disconnect();
      }
    } catch (error) {
      log.error(`[BackendManager] Error disconnecting task ${taskId}: ${String(error)}`);
    }

    this.taskConnections.delete(taskId);
    log.debug(`[BackendManager] Cleaned up backend for task ${taskId}`);
  }

  /**
   * Disconnect and clean up the backend for a specific chat.
   */
  async disconnectChat(chatId: string): Promise<void> {
    await this.disconnectTask(chatId);
  }

  /**
   * Check if a workspace is connected.
   */
  isWorkspaceConnected(workspaceId: string): boolean {
    const state = this.connections.get(workspaceId);
    return state?.backend.isConnected() ?? false;
  }

  /**
   * Get a CommandExecutor for running deterministic commands/files via execution settings.
   */
  async getCommandExecutor(workspaceId: string, directory?: string): Promise<CommandExecutor> {
    // Use test factory if set (for testing)
    if (this.testExecutorFactory) {
      return this.testExecutorFactory(directory ?? ".");
    }

    const state = this.connections.get(workspaceId);
    if (!state) {
      throw new Error(`[BackendManager] Workspace ${workspaceId} not initialized`);
    }

    const dir = directory ?? state.backend.getDirectory();
    const cacheKey = this.buildCommandExecutorCacheKey(workspaceId, dir, state.settings);
    const cachedExecutor = this.commandExecutors.get(cacheKey);
    if (cachedExecutor) {
      return cachedExecutor;
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
      localUserId: requireCurrentUserId(),
      sshTargetOverride: execution.sshTarget,
    };
    if (!state.executionHostBinding) {
      throw new Error(`Workspace ${workspaceId} has no execution-host binding`);
    }
    const executor = await executionHostService.getCommandExecutor(
      state.executionHostBinding,
      commandContext,
    );
    this.commandExecutors.set(cacheKey, executor);
    return executor;
  }

  /**
   * Get a CommandExecutor for running commands/files via execution settings.
   */
  async getCommandExecutorAsync(workspaceId: string, directory: string): Promise<CommandExecutor> {
    // Use test factory if set (for testing)
    if (this.testExecutorFactory) {
      return this.testExecutorFactory(directory);
    }

    await this.ensureWorkspaceState(workspaceId);

    return await this.getCommandExecutor(workspaceId, directory);
  }

  /**
   * Set a custom backend instance (for testing).
   * This bypasses the normal AcpBackend creation.
   * Accepts AcpBackend or MockAcpBackend (both implement Backend).
   */
  setBackendForTesting(backend: Backend): void {
    this.testBackend = backend;
    this.initialized = true;
    this.isTestBackend = true;
  }

  /**
   * Get the test backend if set (for model validation and similar use cases).
   * Returns null if no test backend is set.
   */
  getTestBackend(): Backend | null {
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }
    return null;
  }

  /**
   * Create a temporary backend for a workspace-scoped operation.
   *
   * Unlike a settings-only backend, this preserves the workspace execution
   * node so remote stdio uses MeshAcpTransport instead of local stdio.
   */
  async createBackendForWorkspace(
    workspace: Workspace,
    settings: ServerSettings = workspace.serverSettings,
  ): Promise<Backend> {
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }

    const workspaceOptions = await this.getWorkspaceBackendOptions(workspace);
    const runtimeSettings = await this.buildRuntimeSettings(
      workspace.executionHostBinding,
      settings.agent.provider,
    );
    return this.createBackendForSettings(runtimeSettings, workspaceOptions);
  }

  async createBackendForExecutionHost(
    connectionId: string,
    binding: ExecutionHostBinding,
    provider: AgentProvider,
    sshPassword?: string,
  ): Promise<{ backend: Backend; settings: RuntimeServerSettings }> {
    const settings = await this.buildRuntimeSettings(binding, provider, sshPassword);
    if (this.isTestBackend && this.testBackend) {
      this.taskConnections.set(connectionId, {
        backend: this.testBackend,
        workspaceId: "",
      });
      return { backend: this.testBackend, settings };
    }

    const localNodeId = await this.getLocalMeshNodeId();
    const options: WorkspaceBackendOptions = {
      workspaceId: connectionId,
      localNodeId,
      executionHostBinding: binding,
    };
    const backend = this.createBackendForSettings(settings, options);
    this.taskConnections.set(connectionId, {
      backend,
      workspaceId: "",
    });
    return { backend, settings };
  }

  /**
   * Create a backend for a connection that is not owned by a workspace.
   */
  createStandaloneBackend(settings: RuntimeServerSettings): Backend {
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }
    return this.createBackendForSettings(settings);
  }

  /**
   * Set test settings (for testing).
   * Also enables test mode if not already enabled.
   */
  setSettingsForTesting(settings: RuntimeServerSettings): void {
    this.testSettings = settings;
    this.isTestBackend = true;
    this.initialized = true;
  }

  /**
   * Enable test mode without setting a specific backend.
   * This causes getWorkspaceSettings() to return test settings instead
   * of querying the database.
   * Useful when tests create their own mock backends but still need
   * the backend manager to return test settings.
   */
  enableTestMode(): void {
    this.isTestBackend = true;
    this.initialized = true;
  }

  /**
   * Set a custom command executor factory (for testing).
   * This bypasses the normal execution-provider-based executor creation.
   */
  setExecutorFactoryForTesting(factory: CommandExecutorFactory): void {
    this.testExecutorFactory = factory;
    executionHostService.setExecutorFactoryForTesting(factory);
    this.commandExecutors.clear();
  }

  /**
   * Override the connection timeout (for testing).
   * Allows tests to use a much shorter timeout to avoid long wall-clock waits.
   */
  setConnectionTimeoutForTesting(timeoutMs: number): void {
    this.connectionTimeoutMs = timeoutMs;
  }

  /**
   * Reset the backend manager (for testing).
   * Clears all connections and resets initialization state.
   */
  resetForTesting(): void {
    this.connections.clear();
    this.taskConnections.clear();
    this.commandExecutors.clear();
    this.initialized = false;
    this.testExecutorFactory = null;
    executionHostService.setExecutorFactoryForTesting(null);
    this.isTestBackend = false;
    this.testBackend = null;
    this.testSettings = getDefaultRuntimeServerSettings();
    this.connectionTimeoutMs = getSshReliabilityPolicy().connectionTimeoutMs;
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
