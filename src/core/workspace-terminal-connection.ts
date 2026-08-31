/**
 * Resolves canonical workspace terminal sessions to SSH, local, or Mesh adapters.
 */

import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type {
  Workspace,
  WorkspaceTerminalSession,
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
  claimWorkspaceTerminalAttachment,
  isWorkspaceTerminalAttachmentBlocked,
  type WorkspaceTerminalAttachmentHandle,
} from "./workspace-terminal-attachment-registry";

const log = createLogger("core:workspace-terminal-connection");

export type WorkspaceTerminalTransport = "ssh" | "local" | "mesh";

export interface ResolvedWorkspaceTerminal {
  session: WorkspaceTerminalSession;
  workspace: Workspace;
  transport: WorkspaceTerminalTransport;
  executionNodeId?: string;
}

function targetMismatch(message: string, session: WorkspaceTerminalSession): DomainError {
  return new DomainError("terminal_execution_target_changed", message, {
    details: {
      terminalSessionId: session.config.id,
      workspaceId: session.config.workspaceId,
    },
  });
}

export async function resolveWorkspaceTerminal(
  sessionId: string,
): Promise<ResolvedWorkspaceTerminal> {
  const session = await terminalSessionManager.getSession(sessionId);
  if (!session) {
    throw new DomainError("terminal_session_not_found", "Terminal session not found.", {
      details: { terminalSessionId: sessionId },
    });
  }
  const workspace = await workspaceManager.requireWorkspace(session.config.workspaceId);
  const binding = session.config.targetBinding;
  const target = await resolveWorkspaceExecutionTarget(workspace);
  if (
    binding.targetKey !== target.targetKey
    || binding.workspaceRevision !== (workspace.executionTargetRevision ?? 1)
  ) {
    throw targetMismatch("The workspace execution target changed after this session was created.", session);
  }

  const transport = target.kind === "ssh"
    ? "ssh"
    : target.kind === "local"
      ? "local"
      : "mesh";
  return {
    session,
    workspace,
    transport,
    ...(target.kind === "mesh" ? { executionNodeId: target.nodeId } : {}),
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
    private readonly configuredMode: WorkspaceTerminalSession["config"]["connectionMode"],
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
    if (isWorkspaceTerminalAttachmentBlocked(this.sessionId)) {
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
      if (isWorkspaceTerminalAttachmentBlocked(sessionId)) {
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

export async function createWorkspaceTerminalConnection(
  sessionId: string,
  callbacks: InteractiveTerminalCallbacks,
): Promise<{
  connection: InteractiveTerminalConnection;
  attachment: WorkspaceTerminalAttachmentHandle;
  resolved: ResolvedWorkspaceTerminal;
}> {
  const user = requireCurrentUser();
  const resolved = await resolveWorkspaceTerminal(sessionId);
  if (resolved.transport === "ssh") {
    const connection = new SshInteractiveTerminalConnection(sessionId, callbacks);
    return {
      connection,
      attachment: await claimWorkspaceTerminalAttachment(sessionId, connection),
      resolved,
    };
  }

  const lifecycle: { exitStatus?: "disconnected" | "failed" } = {};
  let credential: ManagedRuntimeCredential | undefined;
  let environment: Record<string, string> | undefined;
  let allowPersistentSessionCreate = true;
  let executor: Awaited<ReturnType<typeof backendManager.getCommandExecutorAsync>> | undefined;
  executor = await backendManager.getCommandExecutorAsync(
    resolved.workspace.id,
    resolved.session.config.directory,
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
  if (allowPersistentSessionCreate) {
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
    if (resolved.transport === "local") {
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
      if (!resolved.executionNodeId) {
        throw new DomainError(
          "mesh_terminal_target_unavailable",
          "The workspace terminal has no Mesh execution target.",
        );
      }
      connection = new MeshInteractiveTerminalConnection({
        workspaceId: resolved.workspace.id,
        executionRoot: resolved.workspace.directory,
        directory: resolved.session.config.directory,
        executionNodeId: resolved.executionNodeId,
        provider: resolved.workspace.serverSettings.agent.provider,
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
      attachment: await claimWorkspaceTerminalAttachment(sessionId, managedConnection),
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
