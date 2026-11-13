/**
 * Core manager for terminal sessions.
 *
 * Workspace terminal sessions are transport-neutral — they work with local
 * and Mesh workspaces. Each session is bound to an immutable
 * snapshot of the workspace execution target at creation time.
 *
 * Direct host sessions use the same lifecycle as workspace sessions.
 */

import {
  DEFAULT_TERMINAL_CONNECTION_MODE,
  DEFAULT_TERMINAL_USE_TMUX,
  type TerminalConnectionMode,
  type ExecutionHostRef,
  type TerminalSession,
  type TerminalSessionStatus,
  type Workspace,
} from "@/shared";
import type { CreateTerminalSessionRequest, UpdateTerminalSessionRequest } from "@/contracts";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import {
  countTerminalSessionsByWorkspace,
  deleteTerminalSession,
  getTerminalSession,
  listTerminalSessions,
  listTerminalSessionsByWorkspace,
  saveTerminalSession,
  resetTerminalConnections,
} from "../persistence/terminal-sessions";
import { terminalSessionEventEmitter } from "./event-emitter";
import { createLogger } from "@pablozaiden/webapp/server";
import { buildPersistentSessionDeleteCommand } from "./terminal/persistent-session";
import { DomainError } from "../domain/domain-error";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";
import {
  blockAndCloseTerminalAttachment,
  unblockTerminalAttachment,
} from "./terminal-attachment-registry";
import { executionHostService } from "./execution-host-service";
import { closeCommandExecutor } from "./command-executor";
import { getInteractiveResourceInternal } from "./collaboration-interactive";

const log = createLogger("core:terminal-session-manager");

function buildRemoteSessionName(id: string): string {
  return `clanky-${id.replace(/-/g, "").slice(0, 24)}`;
}

function buildDefaultTerminalSessionName(workspaceName: string, existingSessionCount: number): string {
  const normalizedWorkspaceName = workspaceName.trim() || "Terminal";
  const normalizedCount = Math.max(0, Math.floor(existingSessionCount));
  return `${normalizedWorkspaceName} ${String(normalizedCount + 1)}`;
}

async function requireWorkspace(workspaceId: string): Promise<Workspace> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", "Workspace not found", {
      details: { workspaceId },
    });
  }
  return workspace;
}

/**
 * Check if a session uses the persistent (dtach) connection mode.
 */
function isPersistentTerminalSession(session: TerminalSession): boolean {
  const effectiveMode = session.state.runtimeConnectionMode ?? session.config.connectionMode;
  return effectiveMode === "dtach";
}

export class TerminalSessionManager {
  reconcileStartupState(): number {
    return resetTerminalConnections();
  }
  async listSessions(workspaceId?: string): Promise<TerminalSession[]> {
    if (workspaceId) {
      return await listTerminalSessionsByWorkspace(workspaceId);
    }
    return await listTerminalSessions();
  }

  async getSession(id: string): Promise<TerminalSession | null> {
    return await getTerminalSession(id);
  }

  async disposeSessionRuntime(session: TerminalSession): Promise<void> {
    await blockAndCloseTerminalAttachment(session.config.id);
    try {
      await this.deletePersistentSession(session);
    } finally {
      unblockTerminalAttachment(session.config.id);
    }
  }

  async createSession(
    request: CreateTerminalSessionRequest,
  ): Promise<TerminalSession> {
    if (request.executionHost) {
      return await this.createExecutionHostSession({
        host: request.executionHost,
        name: request.name,
        directory: request.directory!,
        connectionMode: request.connectionMode ?? DEFAULT_TERMINAL_CONNECTION_MODE,
        useTmux: request.useTmux ?? DEFAULT_TERMINAL_USE_TMUX,
      });
    }
    if (!request.workspaceId) {
      throw new DomainError(
        "terminal_session_source_required",
        "A workspace or execution host is required.",
      );
    }
    const workspaceId = request.workspaceId;
    return await withWorkspaceExecutionLock(workspaceId, async () => {
      const workspace = await requireWorkspace(workspaceId);
      const connectionMode = request.connectionMode ?? DEFAULT_TERMINAL_CONNECTION_MODE;
      const useTmux = request.useTmux ?? DEFAULT_TERMINAL_USE_TMUX;
      await touchWorkspace(workspace.id);

      const requestedName = request.name?.trim();
      const sessionName = requestedName && requestedName.length > 0
        ? requestedName
        : await this.buildDefaultSessionName(workspace);
      return await this.createAndSaveSession({
        workspace,
        name: sessionName,
        directory: request.directory?.trim() || workspace.directory,
        connectionMode,
        useTmux,
      });
    });
  }

  async updateSession(id: string, request: UpdateTerminalSessionRequest): Promise<TerminalSession> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(session, async () => {
      const currentSession = await this.requireSession(id);
      const updatedSession: TerminalSession = {
        config: {
          ...currentSession.config,
          ...(request.name !== undefined ? { name: request.name.trim() } : {}),
          ...(request.isPrivate !== undefined ? { isPrivate: request.isPrivate } : {}),
          updatedAt: new Date().toISOString(),
        },
        state: currentSession.state,
      };
      await saveTerminalSession(updatedSession);
      terminalSessionEventEmitter.emit({
        type: "terminal_session.updated",
        terminalSessionId: updatedSession.config.id,
        session: updatedSession,
        timestamp: updatedSession.config.updatedAt,
      });
      return updatedSession;
    });
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(
      session,
      async () => {
        await blockAndCloseTerminalAttachment(id);
        try {
          return await this.deleteSessionUnlocked(id);
        } finally {
          unblockTerminalAttachment(id);
        }
      },
    );
  }

  async deleteSessionsForWorkspace(
    workspaceId: string,
    options: { lockAlreadyHeld?: boolean } = {},
  ): Promise<void> {
    // Workspace deletion already owns this lock across its full cleanup transaction.
    const operation = async (): Promise<void> => {
      for (const session of await listTerminalSessionsByWorkspace(workspaceId)) {
        await blockAndCloseTerminalAttachment(session.config.id);
        try {
          await this.deleteSessionUnlocked(session.config.id);
        } finally {
          unblockTerminalAttachment(session.config.id);
        }
      }
    };
    if (options.lockAlreadyHeld) {
      await operation();
      return;
    }
    await withWorkspaceExecutionLock(workspaceId, operation);
  }

  async markStatus(id: string, status: TerminalSessionStatus, error?: string): Promise<TerminalSession> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(session, async () => {
      const currentSession = await this.requireSession(id);
      const updatedSession: TerminalSession = {
        config: {
          ...currentSession.config,
          updatedAt: new Date().toISOString(),
        },
        state: {
          ...currentSession.state,
          status,
          error: error?.trim() || undefined,
          lastConnectedAt: status === "connected"
            ? new Date().toISOString()
            : currentSession.state.lastConnectedAt,
        },
      };
      await saveTerminalSession(updatedSession);
      terminalSessionEventEmitter.emit({
        type: "terminal_session.status",
        terminalSessionId: id,
        status,
        error: updatedSession.state.error,
        timestamp: updatedSession.config.updatedAt,
      });
      return updatedSession;
    });
  }

  async updateRuntimeConnectionState(
    id: string,
    options: { runtimeConnectionMode?: TerminalConnectionMode; notice?: string },
  ): Promise<TerminalSession> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(session, async () => {
      const currentSession = await this.requireSession(id);
      const updatedSession: TerminalSession = {
        config: {
          ...currentSession.config,
          updatedAt: new Date().toISOString(),
        },
        state: {
          ...currentSession.state,
          runtimeConnectionMode: options.runtimeConnectionMode,
          notice: options.notice?.trim() || undefined,
        },
      };
      await saveTerminalSession(updatedSession);
      terminalSessionEventEmitter.emit({
        type: "terminal_session.updated",
        terminalSessionId: updatedSession.config.id,
        session: updatedSession,
        timestamp: updatedSession.config.updatedAt,
      });
      return updatedSession;
    });
  }

  private async buildDefaultSessionName(workspace: Workspace): Promise<string> {
    const existingSessionCount = await countTerminalSessionsByWorkspace(workspace.id);
    return buildDefaultTerminalSessionName(workspace.name, existingSessionCount);
  }

  private async createExecutionHostSession(options: {
    host: ExecutionHostRef;
    name: string;
    directory: string;
    connectionMode: TerminalConnectionMode;
    useTmux: boolean;
  }): Promise<TerminalSession> {
    await executionHostService.requireCapability(
      options.host,
      "interactiveTerminal",
    );
    const binding = executionHostService.getBinding(options.host);
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const session: TerminalSession = {
      config: {
        id: sessionId,
        name: options.name.trim(),
        directory: options.directory.trim(),
        connectionMode: options.connectionMode,
        useTmux: options.useTmux,
        remoteSessionName: buildRemoteSessionName(sessionId),
        executionHostBinding: binding,
        createdAt: now,
        updatedAt: now,
      },
      state: { status: "ready" },
    };
    await saveTerminalSession(session);
    terminalSessionEventEmitter.emit({
      type: "terminal_session.created",
      terminalSessionId: sessionId,
      session,
      timestamp: now,
    });
    return session;
  }

  private async withSessionLock<T>(
    session: TerminalSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    return session.config.workspaceId
      ? await withWorkspaceExecutionLock(session.config.workspaceId, operation)
      : await operation();
  }

  private async createAndSaveSession(options: {
    workspace: Workspace;
    name: string;
    directory: string;
    connectionMode: TerminalConnectionMode;
    useTmux: boolean;
  }): Promise<TerminalSession> {
    executionHostService.requireBindingCapability(
      options.workspace.executionHostBinding,
      "interactiveTerminal",
    );
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const session: TerminalSession = {
      config: {
        id: sessionId,
        name: options.name,
        workspaceId: options.workspace.id,
        directory: options.directory,
        connectionMode: options.connectionMode,
        useTmux: options.useTmux,
        remoteSessionName: buildRemoteSessionName(sessionId),
        workspaceExecutionTargetRevision: options.workspace.executionTargetRevision,
        executionHostBinding: options.workspace.executionHostBinding,
        createdAt: now,
        updatedAt: now,
      },
      state: {
        status: "ready",
      },
    };

    await saveTerminalSession(session);

    terminalSessionEventEmitter.emit({
      type: "terminal_session.created",
      terminalSessionId: session.config.id,
      session,
      timestamp: now,
    });
    return session;
  }

  private async requireSession(id: string): Promise<TerminalSession> {
    const session = await getTerminalSession(id);
    if (!session) {
      throw new DomainError("terminal_session_not_found", "Terminal session not found", {
        details: { sessionId: id },
      });
    }
    return session;
  }

  private async deleteSessionUnlocked(id: string): Promise<boolean> {
    const currentSession = await this.getSession(id);
    if (!currentSession) {
      return false;
    }
    await this.deletePersistentSessionBestEffort(currentSession);
    if (currentSession.config.workspaceId) {
      const identity = await managedContextIdentityResolver.forTerminalSession(
        currentSession.config.id,
        currentSession.config.workspaceId,
      );
      await managedCredentialService.revokeContextIfConfigured(identity);
    }

    const workspaceId = currentSession.config.workspaceId;
    const membershipId = workspaceId
      ? getInteractiveResourceInternal({ kind: "terminal", id, workspaceId })?.membershipId ?? null
      : undefined;
    const deleted = await deleteTerminalSession(id);
    if (deleted) {
      terminalSessionEventEmitter.emit({
        type: "terminal_session.deleted",
        terminalSessionId: id,
        workspaceId,
        membershipId,
        timestamp: new Date().toISOString(),
      });
    }
    return deleted;
  }

  private async deletePersistentSessionBestEffort(session: TerminalSession): Promise<void> {
    try {
      await this.deletePersistentSession(session);
    } catch (error) {
      log.warn("Failed to stop remote persistent session during deletion", {
        terminalSessionId: session.config.id,
        workspaceId: session.config.workspaceId ?? null,
        remoteSessionName: session.config.remoteSessionName,
        status: session.state.status,
        error: String(error),
      });
    }
  }

  private async deletePersistentSession(session: TerminalSession): Promise<void> {
    if (!isPersistentTerminalSession(session)) {
      return;
    }

    executionHostService.validateBinding(session.config.executionHostBinding);
    const executor = await executionHostService.getCommandExecutor(session.config.executionHostBinding, {
      operationId: `terminal-cleanup:${session.config.id}`,
      directory: session.config.directory,
    });
    try {
      const killResult = await executor.exec("bash", ["-lc", buildPersistentSessionDeleteCommand(session)], {
        cwd: session.config.directory,
      });
      if (!killResult.success) {
        throw new Error(killResult.stderr.trim() || killResult.stdout.trim() || "Failed to stop remote persistent session");
      }
    } finally {
      closeCommandExecutor(executor);
    }
  }
}

export const terminalSessionManager = new TerminalSessionManager();
