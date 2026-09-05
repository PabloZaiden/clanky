/**
 * Resolves canonical workspace terminal sessions to SSH, local, or Mesh adapters.
 */

import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type {
  ExecutionHostBinding,
  Workspace,
  TerminalSession,
} from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { backendManager } from "./backend-manager";
import { DomainError, isDomainError } from "./domain-error";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { buildManagedContextEnvironment } from "./managed-context-environment";
import { managedCredentialService, type ManagedRuntimeCredential } from "./managed-credential-service";
import { terminalSessionManager } from "./terminal-session-manager";
import {
  LocalTerminalConnection,
  MeshInteractiveTerminalConnection,
  SshInteractiveTerminalConnection,
  type InteractiveTerminalCallbacks,
  type InteractiveTerminalConnection,
  type InteractiveTerminalConnectResult,
} from "./terminal";
import { DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS } from "./ssh-bridge/constants";
import { hasPersistentSession } from "./ssh-persistent-session";
import { requireCurrentUser, runWithCurrentUser } from "./user-context";
import { workspaceManager } from "./workspace-manager";
import { resolveWorkspaceExecutionTarget } from "./workspace-execution-target";
import {
  claimTerminalAttachment,
  isTerminalAttachmentBlocked,
  type TerminalAttachmentHandle,
} from "./terminal-attachment-registry";
import { executionHostService } from "./execution-host-service";

const log = createLogger("core:terminal-connection");

export interface ResolvedTerminal {
  session: TerminalSession;
  workspace?: Workspace;
  executionHostBinding: ExecutionHostBinding;
}

function targetMismatch(message: string, session: TerminalSession): DomainError {
  return new DomainError("terminal_execution_target_changed", message, {
    details: {
      terminalSessionId: session.config.id,
      workspaceId: session.config.workspaceId,
    },
  });
}

export async function resolveTerminal(
  sessionId: string,
): Promise<ResolvedTerminal> {
  const session = await terminalSessionManager.getSession(sessionId);
  if (!session) {
    throw new DomainError("terminal_session_not_found", "Terminal session not found.", {
      details: { terminalSessionId: sessionId },
    });
  }
  if (!session.config.workspaceId) {
    const binding = session.config.executionHostBinding;
    executionHostService.validateBinding(binding);
    return {
      session,
      executionHostBinding: binding,
    };
  }
  const workspace = await workspaceManager.requireWorkspace(session.config.workspaceId);
  const binding = session.config.executionHostBinding;
  const target = await resolveWorkspaceExecutionTarget(workspace);
  if (
    binding.targetKey !== target.targetKey
    || binding.revision !== target.binding.revision
    || session.config.workspaceExecutionTargetRevision
      !== workspace.executionTargetRevision
  ) {
    throw targetMismatch("The workspace execution target changed after this session was created.", session);
  }

  return {
    session,
    workspace,
    executionHostBinding: binding,
  };
}

class StatusManagedTerminalConnection implements InteractiveTerminalConnection {
  private disposed = false;
  private connectFailed = false;
  private connected = false;
  private launchCleanupDone = false;

  constructor(
    private readonly sessionId: string,
    private readonly user: CurrentUser,
    private readonly connection: InteractiveTerminalConnection,
    private readonly configuredMode: TerminalSession["config"]["connectionMode"],
    private readonly lifecycle: { exitStatus?: "disconnected" | "failed" },
    private readonly cleanupFailedLaunch?: (error: unknown) => Promise<void>,
  ) {}

  async connect(): Promise<InteractiveTerminalConnectResult> {
    if (this.disposed) {
      throw new DomainError("terminal_connection_closed", "The terminal connection is closed.");
    }
    try {
      await runWithCurrentUser(
        this.user,
        async () => await terminalSessionManager.markStatus(this.sessionId, "connecting"),
      );
      if (this.disposed) {
        throw new DomainError("terminal_connection_closed", "The terminal connection is closed.");
      }
      const result = await this.connection.connect();
      if (this.disposed) {
        await this.connection.dispose();
        throw new DomainError("terminal_connection_closed", "The terminal connection was closed while connecting.");
      }
      await runWithCurrentUser(
        this.user,
        async () => {
          await terminalSessionManager.updateRuntimeConnectionState(this.sessionId, {
            runtimeConnectionMode: result.runtimeConnectionMode === this.configuredMode
              ? undefined
              : result.runtimeConnectionMode,
            notice: result.notice,
          });
          await terminalSessionManager.markStatus(this.sessionId, "connected");
        },
      );
      this.connected = true;
      return result;
    } catch (error) {
      if (this.disposed) {
        await this.cleanupLaunchCredential(error);
        throw error;
      }
      this.connectFailed = true;
      let failure = error;
      try {
        await this.cleanupLaunchCredential(error);
      } catch (cleanupError) {
        failure = cleanupError;
      }
      await runWithCurrentUser(
        this.user,
        async () => await terminalSessionManager.markStatus(
          this.sessionId,
          "failed",
          failure instanceof Error ? failure.message : String(failure),
        ),
      );
      throw failure;
    }
  }

  private async cleanupLaunchCredential(error: unknown): Promise<void> {
    if (!this.cleanupFailedLaunch || this.launchCleanupDone || this.connected) {
      return;
    }
    this.launchCleanupDone = true;
    await this.cleanupFailedLaunch(error);
  }

  sendInput(data: string): void {
    this.connection.sendInput(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.connection.resize(cols, rows);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.connection.dispose();
    if (!this.connected) {
      try {
        await this.cleanupLaunchCredential(
          new DomainError("terminal_connection_closed", "The terminal connection was closed before it connected."),
        );
      } catch (error) {
        if (!(isDomainError(error) && error.code === "terminal_connection_closed")) {
          log.warn("Failed to clean up a cancelled terminal launch", {
            terminalSessionId: this.sessionId,
            error: String(error),
          });
        }
      }
    }
    if (isTerminalAttachmentBlocked(this.sessionId)) {
      return;
    }
    if (this.connectFailed || this.lifecycle.exitStatus === "failed") {
      return;
    }
    try {
      await runWithCurrentUser(
        this.user,
        async () => await terminalSessionManager.markStatus(this.sessionId, "disconnected"),
      );
    } catch (error) {
      log.warn("Failed to mark terminal session disconnected", {
        terminalSessionId: this.sessionId,
        error: String(error),
      });
    }
  }
}

function buildStatusCallbacks(
  sessionId: string,
  user: CurrentUser,
  callbacks: InteractiveTerminalCallbacks,
  lifecycle: { exitStatus?: "disconnected" | "failed" },
): InteractiveTerminalCallbacks {
  return {
    onOutput: callbacks.onOutput,
    onClipboardCopy: callbacks.onClipboardCopy,
    onError: callbacks.onError,
    onExit: (code, signal) => {
      const status = code === 0 || code === null ? "disconnected" : "failed";
      lifecycle.exitStatus = status;
      if (isTerminalAttachmentBlocked(sessionId)) {
        callbacks.onExit?.(code, signal);
        return;
      }
      const error = status === "failed"
        ? `Terminal process exited with code ${String(code)}${signal ? ` (${signal})` : ""}`
        : undefined;
      void runWithCurrentUser(
        user,
        async () => await terminalSessionManager.markStatus(sessionId, status, error),
      ).catch((statusError: Error) => {
        log.warn("Failed to update terminal session status after exit", {
          terminalSessionId: sessionId,
          error: String(statusError),
        });
      });
      callbacks.onExit?.(code, signal);
    },
  };
}

export async function createTerminalConnection(
  sessionId: string,
  callbacks: InteractiveTerminalCallbacks,
  credentialToken?: string,
): Promise<{
  connection: InteractiveTerminalConnection;
  attachment: TerminalAttachmentHandle;
  resolved: ResolvedTerminal;
}> {
  const user = requireCurrentUser();
  const resolved = await resolveTerminal(sessionId);
  const host = resolved.executionHostBinding.host;
  if (host.kind === "ssh") {
    const connection = new SshInteractiveTerminalConnection(
      sessionId,
      callbacks,
      credentialToken,
    );
    return {
      connection,
      attachment: await claimTerminalAttachment(sessionId, connection),
      resolved,
    };
  }

  const lifecycle: { exitStatus?: "disconnected" | "failed" } = {};
  let credential: ManagedRuntimeCredential | undefined;
  let environment: Record<string, string> | undefined;
  let allowPersistentSessionCreate = true;
  let executor: Awaited<ReturnType<typeof backendManager.getCommandExecutorAsync>> | undefined;
  executor = resolved.workspace
    ? await backendManager.getCommandExecutorAsync(
        resolved.workspace.id,
        resolved.session.config.directory,
      )
    : await executionHostService.getCommandExecutor(
        resolved.executionHostBinding,
        {
          operationId: `terminal:${sessionId}`,
          directory: resolved.session.config.directory,
          localUserId: user.id,
        },
      );
  const runtimeMode = resolved.session.state.runtimeConnectionMode
    ?? resolved.session.config.connectionMode;
  const persistentRuntimeExists = runtimeMode === "dtach"
    && await hasPersistentSession(
      executor,
      {
        config: {
          id: resolved.session.config.id,
          remoteSessionName: resolved.session.config.remoteSessionName,
        },
      },
      resolved.session.config.directory,
      DEFAULT_SSH_TERMINAL_COMMAND_TIMEOUT_MS,
    );
  allowPersistentSessionCreate = !persistentRuntimeExists;
  if (allowPersistentSessionCreate && resolved.workspace) {
    const identity = await managedContextIdentityResolver.forTerminalSession(
      sessionId,
      resolved.workspace.id,
    );
    credential = await managedCredentialService.ensureCredentialForRuntime(identity, "recreate");
    environment = buildManagedContextEnvironment(credential);
  }
  const statusCallbacks = buildStatusCallbacks(sessionId, user, callbacks, lifecycle);
  try {
    let connection: InteractiveTerminalConnection;
    if (host.kind === "local") {
      if (!executor) {
        throw new DomainError("terminal_connection_unavailable", "The local terminal executor is unavailable.");
      }
      connection = new LocalTerminalConnection({
        sessionId,
        remoteSessionName: resolved.session.config.remoteSessionName,
        directory: resolved.session.config.directory,
        connectionMode: resolved.session.config.connectionMode,
        runtimeConnectionMode: resolved.session.state.runtimeConnectionMode,
        useTmux: resolved.session.config.useTmux,
        executor,
        environment,
        allowPersistentSessionCreate,
        callbacks: statusCallbacks,
        onRuntimeConnectionState: async (state) => {
          await runWithCurrentUser(
            user,
            async () => await terminalSessionManager.updateRuntimeConnectionState(sessionId, state),
          );
        },
        onPersistentSessionAttachUnavailable: async () => {
          if (!resolved.workspace) {
            return {};
          }
          const identity = await managedContextIdentityResolver.forTerminalSession(
            sessionId,
            resolved.workspace.id,
          );
          credential = await managedCredentialService.ensureCredentialForRuntime(identity, "recreate");
          return {
            environment: credential
              ? buildManagedContextEnvironment(credential)
              : undefined,
          };
        },
      });
    } else {
      connection = new MeshInteractiveTerminalConnection({
        workspaceId: resolved.workspace?.id ?? `execution-host:${resolved.executionHostBinding.targetKey}`,
        executionRoot: resolved.workspace?.directory ?? resolved.session.config.directory,
        directory: resolved.session.config.directory,
        executionNodeId: host.nodeId,
        provider: resolved.workspace?.serverSettings.agent.provider
          ?? await executionHostService.resolveAgentProvider(
            resolved.executionHostBinding.host,
            user.id,
          ),
        terminalSessionId: sessionId,
        remoteSessionName: resolved.session.config.remoteSessionName,
        connectionMode: resolved.session.state.runtimeConnectionMode
          ?? resolved.session.config.connectionMode,
        useTmux: resolved.session.config.useTmux,
        allowPersistentSessionCreate,
        environment,
        callbacks: statusCallbacks,
        localUserId: user.id,
        onPersistentSessionAttachUnavailable: async () => {
          if (!resolved.workspace) {
            return {};
          }
          const identity = await managedContextIdentityResolver.forTerminalSession(
            sessionId,
            resolved.workspace.id,
          );
          credential = await managedCredentialService.ensureCredentialForRuntime(identity, "recreate");
          return {
            environment: credential
              ? buildManagedContextEnvironment(credential)
              : undefined,
          };
        },
      });
    }
    const managedConnection = new StatusManagedTerminalConnection(
      sessionId,
      user,
      connection,
      resolved.session.config.connectionMode,
      lifecycle,
      credential
        ? async (error) => {
            await runWithCurrentUser(
              user,
              async () => await managedCredentialService.cleanupFailedLaunch(credential, error),
            );
          }
        : undefined,
    );
    return {
      connection: managedConnection,
      attachment: await claimTerminalAttachment(sessionId, managedConnection),
      resolved,
    };
  } catch (error) {
    if (credential) {
      await runWithCurrentUser(
        user,
        async () => await managedCredentialService.cleanupFailedLaunch(credential, error),
      );
    }
    throw error;
  }
}
