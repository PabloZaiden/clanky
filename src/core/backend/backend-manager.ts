/**
 * Backend manager for Ralph Loops Management System.
 * Manages multiple workspace-specific backend connections.
 *
 * Each workspace can have its own server settings and connection,
 * allowing parallel operation of loops across different workspaces.
 */

import { AcpBackend } from "../../backends/acp";
import type { Backend } from "../../backends/types";
import { getWorkspace } from "../../persistence/workspaces";
import { getDefaultServerSettings, type ServerSettings } from "../../types/settings";
import { loopEventEmitter } from "../event-emitter";
import type { LoopEvent } from "../../types/events";
import type { CommandExecutor } from "../command-executor";
import { CommandExecutorImpl } from "../remote-command-executor";
import { GitService } from "../git-service";
import { log } from "../logger";
import { buildConnectionConfig } from "./backend-connection-pool";
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  deriveExecutionSettings,
  buildAgentServerUrl,
  type WorkspaceConnectionState,
  type LoopConnectionState,
  type ServerEvent,
} from "./backend-state";
import type { CommandExecutorFactory } from "./backend-executor-factory";

/**
 * Backend manager supporting multiple workspace connections.
 * Each workspace can have its own server settings and connection.
 */
class BackendManager {
  /** Map of workspace ID to connection state (for workspace-level operations) */
  private connections = new Map<string, WorkspaceConnectionState>();
  /** Map of loop ID to its own dedicated backend connection */
  private loopConnections = new Map<string, LoopConnectionState>();
  private initialized = false;
  /** Custom executor factory for testing */
  private testExecutorFactory: CommandExecutorFactory | null = null;
  /** Flag to indicate a test backend is being used (should be preserved on reset) */
  private isTestBackend = false;
  /** Test backend instance (when isTestBackend is true) */
  private testBackend: Backend | null = null;
  /** Test settings (when isTestBackend is true) */
  private testSettings: ServerSettings = getDefaultServerSettings();
  /** Overridable connection timeout (ms) for testing. Defaults to DEFAULT_CONNECTION_TIMEOUT_MS. */
  private connectionTimeoutMs: number = DEFAULT_CONNECTION_TIMEOUT_MS;

  /**
   * Create a backend instance for the configured agent provider.
   */
  private createBackendForSettings(settings: ServerSettings): Backend {
    switch (settings.agent.provider) {
      case "opencode":
      case "copilot":
        // Both providers use the same backend implementation for now.
        return new AcpBackend();
      default:
        return new AcpBackend();
    }
  }

  /**
   * Static capabilities exposed to the status endpoint.
   */
  private getAgentCapabilities(_settings: ServerSettings): string[] {
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

    const settings = workspace.serverSettings;
    let state = this.connections.get(workspaceId);
    if (!state) {
      state = {
        backend: this.createBackendForSettings(settings),
        settings,
        connectionError: null,
      };
      this.connections.set(workspaceId, state);
      return state;
    }

    if (state.settings.agent.provider !== settings.agent.provider) {
      const previousBackend = state.backend;
      if (previousBackend.isConnected()) {
        await previousBackend.disconnect();
      }
      state.backend = this.createBackendForSettings(settings);
      state.connectionError = null;
    }

    state.settings = settings;
    return state;
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

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Connection timed out after ${this.connectionTimeoutMs}ms`)),
          this.connectionTimeoutMs,
        );
      });

      await Promise.race([
        state.backend.connect(config, abortController.signal),
        timeoutPromise,
      ]);

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
  }

  /**
   * Reset connection for a specific workspace.
   * Disconnects the backend and clears the cached instance.
   * Used for recovery when connections become stale.
   */
  async resetWorkspaceConnection(workspaceId: string): Promise<void> {
    const state = this.connections.get(workspaceId);

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

    // Reset all loop-level connections
    for (const [loopId, state] of this.loopConnections) {
      try {
        state.backend.abortAllSubscriptions();
        if (state.backend.isConnected()) {
          await state.backend.disconnect();
        }
      } catch (error) {
        log.error(`Error resetting loop connection for ${loopId}: ${String(error)}`);
      }
    }

    // If not using test backend, clear all connections
    if (!this.isTestBackend) {
      this.connections.clear();
      this.loopConnections.clear();
    }

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
    directory: string
  ): Promise<{ success: boolean; error?: string }> {
    // Reuse the configured test backend when present so tests can stub connection behavior.
    const testBackend = this.isTestBackend && this.testBackend
      ? this.testBackend
      : this.createBackendForSettings(settings);
    const config = buildConnectionConfig(settings, directory);
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
   * Validate that a directory exists and is a git repository on the remote server.
   * This is used during workspace creation to validate the directory before saving.
   *
   * @param settings - Server settings to use for connection
   * @param directory - The directory to validate
   * @returns Object with success flag, isGitRepo boolean, directoryExists boolean, and optional error message
   */
  async validateRemoteDirectory(
    settings: ServerSettings,
    directory: string
  ): Promise<{ success: boolean; isGitRepo?: boolean; directoryExists?: boolean; error?: string }> {
    log.debug("Validating remote directory", {
      directory,
      provider: settings.agent.provider,
      transport: settings.agent.transport,
      executionProvider: deriveExecutionSettings(settings).provider,
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
      const execution = deriveExecutionSettings(settings);
      const executor = new CommandExecutorImpl({
        provider: execution.provider,
        directory,
        host: execution.sshTarget?.host,
        port: execution.sshTarget?.port,
        user: execution.sshTarget?.username,
        password: execution.sshTarget?.password,
        identityFile: execution.sshTarget?.identityFile,
        timeoutMs: this.connectionTimeoutMs,
      });

      if (execution.provider === "ssh") {
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

  /**
   * Get connection status for a specific workspace.
   */
  async getWorkspaceStatus(workspaceId: string): Promise<import("../../types/settings").ConnectionStatus> {
    const workspace = await getWorkspace(workspaceId);
    const settings = workspace?.serverSettings ?? getDefaultServerSettings();
    const state = this.connections.get(workspaceId);
    const status: import("../../types/settings").ConnectionStatus = {
      connected: state?.backend.isConnected() ?? false,
      provider: settings.agent.provider,
      transport: settings.agent.transport,
      capabilities: this.getAgentCapabilities(settings),
      serverUrl: buildAgentServerUrl(settings),
      error: state?.connectionError ?? undefined,
    };

    if (!workspace) {
      status.connected = false;
      status.error = "Workspace not found";
      return status;
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
  async getWorkspaceSettings(workspaceId: string): Promise<ServerSettings> {
    // In test mode, return test settings
    if (this.isTestBackend) {
      return this.testSettings;
    }

    // In production, fetch from database
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace.serverSettings;
  }

  /**
   * Get an already-initialized backend instance for a workspace
   * (workspace-level operations only).
   *
   * Used for operations that don't belong to a specific loop (name generation,
   * model listing, directory validation) when the workspace state is already
   * initialized.
   *
   * IMPORTANT: Do NOT use this for loop execution. Use getLoopBackend() instead.
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
   * Get a dedicated backend instance for a loop.
   * Each loop gets its own AcpBackend so that concurrent loops
   * in the same workspace don't interfere with each other.
   *
   * The actual directory binding happens later when LoopEngine calls
   * backend.connect() in setupSession() with the worktree directory.
   *
   * In test mode, returns the shared test backend (tests manage their own isolation).
   *
   * @param loopId - The loop ID
   * @param workspaceId - The workspace ID (for settings lookup)
   * @returns A Backend instance dedicated to this loop
   */
  getLoopBackend(loopId: string, workspaceId: string): Backend {
    // Use test backend if set (tests share a single mock backend)
    if (this.isTestBackend && this.testBackend) {
      return this.testBackend;
    }

    const existing = this.loopConnections.get(loopId);
    if (existing) {
      return existing.backend;
    }

    // Create a new dedicated backend for this loop
    const settings = this.connections.get(workspaceId)?.settings ?? getDefaultServerSettings();
    const backend = this.createBackendForSettings(settings);
    this.loopConnections.set(loopId, {
      backend,
      workspaceId,
    });
    log.debug(`[BackendManager] Created dedicated backend for loop ${loopId}`);
    return backend;
  }

  /**
   * Get a dedicated backend instance for a chat.
   * Chats share the same dedicated-backend pool semantics as loops.
   */
  getChatBackend(chatId: string, workspaceId: string): Backend {
    return this.getLoopBackend(chatId, workspaceId);
  }

  /**
   * Disconnect and clean up the backend for a specific loop.
   * Called when a loop is stopped, completed, or failed.
   *
   * @param loopId - The loop ID to clean up
   */
  async disconnectLoop(loopId: string): Promise<void> {
    // In test mode, don't disconnect the shared test backend
    if (this.isTestBackend) {
      return;
    }

    const state = this.loopConnections.get(loopId);
    if (!state) {
      return;
    }

    try {
      state.backend.abortAllSubscriptions();
      if (state.backend.isConnected()) {
        await state.backend.disconnect();
      }
    } catch (error) {
      log.error(`[BackendManager] Error disconnecting loop ${loopId}: ${String(error)}`);
    }

    this.loopConnections.delete(loopId);
    log.debug(`[BackendManager] Cleaned up backend for loop ${loopId}`);
  }

  /**
   * Disconnect and clean up the backend for a specific chat.
   */
  async disconnectChat(chatId: string): Promise<void> {
    await this.disconnectLoop(chatId);
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
  getCommandExecutor(workspaceId: string, directory?: string): CommandExecutor {
    // Use test factory if set (for testing)
    if (this.testExecutorFactory) {
      return this.testExecutorFactory(directory ?? ".");
    }

    const state = this.connections.get(workspaceId);
    if (!state) {
      throw new Error(`[BackendManager] Workspace ${workspaceId} not initialized`);
    }

    const dir = directory ?? state.backend.getDirectory();
    const execution = deriveExecutionSettings(state.settings);
    const commandExecutorLogContext: Record<string, string | number> = {
      directory: dir,
      executionProvider: execution.provider,
      ...(execution.sshTarget?.host ? { host: execution.sshTarget.host } : {}),
      ...(typeof execution.sshTarget?.port === "number" ? { port: execution.sshTarget.port } : {}),
      ...(execution.sshTarget?.username ? { user: execution.sshTarget.username } : {}),
    };
    log.debug(`[BackendManager] Creating CommandExecutor for workspace ${workspaceId}`, commandExecutorLogContext);
    return new CommandExecutorImpl({
      provider: execution.provider,
      directory: dir,
      host: execution.sshTarget?.host,
      port: execution.sshTarget?.port,
      user: execution.sshTarget?.username,
      password: execution.sshTarget?.password,
      identityFile: execution.sshTarget?.identityFile,
    });
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

    return this.getCommandExecutor(workspaceId, directory);
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
   * Create a new backend instance for ad-hoc operations (e.g. model discovery).
   */
  createBackend(settings: ServerSettings): Backend {
    return this.createBackendForSettings(settings);
  }

  /**
   * Set test settings (for testing).
   * Also enables test mode if not already enabled.
   */
  setSettingsForTesting(settings: ServerSettings): void {
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
    this.loopConnections.clear();
    this.initialized = false;
    this.testExecutorFactory = null;
    this.isTestBackend = false;
    this.testBackend = null;
    this.testSettings = getDefaultServerSettings();
    this.connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  /**
   * Emit a server event.
   */
  private emitEvent(event: ServerEvent): void {
    // Cast to LoopEvent since the emitter accepts that type
    // The WebSocket handler will pass through any event with a type property
    loopEventEmitter.emit(event as unknown as LoopEvent);
  }
}

/**
 * Global backend manager singleton.
 */
export const backendManager = new BackendManager();
