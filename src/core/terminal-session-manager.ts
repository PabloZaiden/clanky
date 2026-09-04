/**
 * Core manager for workspace terminal sessions.
 *
 * Workspace terminal sessions are transport-neutral — they work with local
 * stdio, SSH, and Mesh workspaces. Each session is bound to an immutable
 * snapshot of the workspace execution target at creation time.
 *
 * Standalone SSH-server sessions remain SSH-specific and are not managed here.
 */

import {
  DEFAULT_TERMINAL_CONNECTION_MODE,
  DEFAULT_TERMINAL_USE_TMUX,
  type TerminalConnectionMode,
  type TerminalTargetBinding,
  type ExecutionHostBinding,
  type ExecutionHostRef,
  type WorkspaceTerminalSession,
  type TerminalSessionStatus,
  type Workspace,
} from "@/shared";
import type { CreateTerminalSessionRequest, UpdateTerminalSessionRequest } from "@/contracts";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import {
  countTerminalSessionsByWorkspace,
  deleteTerminalSession,
  getTerminalSession,
  getTerminalSessionByTaskId,
  listTerminalSessions,
  listTerminalSessionsByWorkspace,
  saveTerminalSession,
} from "../persistence/terminal-sessions";
import { loadTask } from "../persistence/tasks";
import { backendManager } from "./backend-manager";
import { terminalSessionEventEmitter } from "./event-emitter";
import { createLogger } from "@pablozaiden/webapp/server";
import { buildPersistentSessionDeleteCommand } from "./ssh-persistent-session";
import { isUniqueConstraint } from "../persistence/errors";
import { DomainError } from "./domain-error";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { resolveWorkspaceExecutionTarget } from "./workspace-execution-target";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";
import {
  blockAndCloseWorkspaceTerminalAttachment,
  unblockWorkspaceTerminalAttachment,
} from "./workspace-terminal-attachment-registry";
import { executionHostService } from "./execution-host-service";

const log = createLogger("core:terminal-session-manager");

function buildRemoteSessionName(id: string): string {
  return `clanky-${id.replace(/-/g, "").slice(0, 24)}`;
}

function buildDefaultTerminalSessionName(workspaceName: string, existingSessionCount: number): string {
  const normalizedWorkspaceName = workspaceName.trim() || "Terminal";
  const normalizedCount = Math.max(0, Math.floor(existingSessionCount));
  return `${normalizedWorkspaceName} ${String(normalizedCount + 1)}`;
}

function buildTaskTerminalSessionName(taskName: string): string {
  const normalizedTaskName = taskName.trim() || "Task";
  return `${normalizedTaskName} Terminal`;
}

/**
 * Build a target binding from the workspace's current execution target settings.
 */
async function buildTargetBindings(workspace: Workspace): Promise<{
  legacy: TerminalTargetBinding;
  canonical: ExecutionHostBinding | null;
}> {
  const target = await resolveWorkspaceExecutionTarget(workspace);
  const canonical = workspace.executionHostBinding ?? (target.hostRef
    ? {
        host: target.hostRef,
        targetKey: target.targetKey,
        revision: workspace.executionTargetRevision ?? 1,
      }
    : null);
  if (target.kind === "ssh") {
    return {
      legacy: {
      transport: "ssh",
        targetKey: target.targetKey,
        workspaceRevision: workspace.executionTargetRevision ?? 1,
        hostname: target.target.host,
        port: target.target.port,
        username: target.target.username,
      },
      canonical,
    };
  }
  const legacy: TerminalTargetBinding = {
    transport: "stdio",
    targetKey: target.targetKey,
    workspaceRevision: workspace.executionTargetRevision ?? 1,
  };
  if (target.kind === "mesh") {
    legacy.executionNodeId = target.nodeId;
  }
  return { legacy, canonical };
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
 * Check if a session uses the persistent (dtach) connection mode,
 * accounting for runtime fallbacks.
 */
function isPersistentTerminalSession(session: WorkspaceTerminalSession): boolean {
  const effectiveMode = session.state.runtimeConnectionMode ?? session.config.connectionMode;
  return effectiveMode === "dtach";
}

export class TerminalSessionManager {
  async listSessions(workspaceId?: string): Promise<WorkspaceTerminalSession[]> {
    if (workspaceId) {
      return await listTerminalSessionsByWorkspace(workspaceId);
    }
    return await listTerminalSessions();
  }

  async getSession(id: string): Promise<WorkspaceTerminalSession | null> {
    return await getTerminalSession(id);
  }

  async getSessionByTaskId(taskId: string): Promise<WorkspaceTerminalSession | null> {
    return await getTerminalSessionByTaskId(taskId);
  }

  async createSession(
    request: CreateTerminalSessionRequest,
  ): Promise<WorkspaceTerminalSession> {
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
        directory: workspace.directory,
        connectionMode,
        useTmux,
      });
    });
  }

  async updateSession(id: string, request: UpdateTerminalSessionRequest): Promise<WorkspaceTerminalSession> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(session, async () => {
      const currentSession = await this.requireSession(id);
      const updatedSession: WorkspaceTerminalSession = {
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
        await blockAndCloseWorkspaceTerminalAttachment(id);
        try {
          return await this.deleteSessionUnlocked(id);
        } finally {
          unblockWorkspaceTerminalAttachment(id);
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
        await blockAndCloseWorkspaceTerminalAttachment(session.config.id);
        try {
          await this.deleteSessionUnlocked(session.config.id);
        } finally {
          unblockWorkspaceTerminalAttachment(session.config.id);
        }
      }
    };
    if (options.lockAlreadyHeld) {
      await operation();
      return;
    }
    await withWorkspaceExecutionLock(workspaceId, operation);
  }

  async getOrCreateTaskSession(
    taskId: string,
  ): Promise<WorkspaceTerminalSession> {
    const { taskManager } = await import("./task-manager");
    const task = await taskManager.getTask(taskId) ?? await loadTask(taskId);
    if (!task) {
      throw new DomainError("task_not_found", "Task not found", {
        details: { taskId },
      });
    }

    const workspace = await requireWorkspace(task.config.workspaceId);
    return await withWorkspaceExecutionLock(workspace.id, async () => {
      const existingSession = await getTerminalSessionByTaskId(taskId);
      if (existingSession) {
        return existingSession;
      }

      const currentWorkspace = await requireWorkspace(workspace.id);
      await touchWorkspace(currentWorkspace.id);

      const directory = task.config.useWorktree
        ? task.state.git?.worktreePath ?? null
        : task.config.directory;
      if (!directory) {
        throw new DomainError(
          "task_working_directory_unavailable",
          "Task working directory is not available",
          { details: { taskId } },
        );
      }

      return await this.createAndSaveSession({
        workspace: currentWorkspace,
        name: buildTaskTerminalSessionName(task.config.name),
        directory,
        taskId,
        connectionMode: DEFAULT_TERMINAL_CONNECTION_MODE,
        useTmux: DEFAULT_TERMINAL_USE_TMUX,
      });
    });
  }

  async deleteSessionByTaskId(taskId: string): Promise<boolean> {
    const session = await getTerminalSessionByTaskId(taskId);
    if (!session) {
      return false;
    }
    return await this.deleteSession(session.config.id);
  }

  async markStatus(id: string, status: TerminalSessionStatus, error?: string): Promise<WorkspaceTerminalSession> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(session, async () => {
      const currentSession = await this.requireSession(id);
      const updatedSession: WorkspaceTerminalSession = {
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
  ): Promise<WorkspaceTerminalSession> {
    const session = await this.requireSession(id);
    return await this.withSessionLock(session, async () => {
      const currentSession = await this.requireSession(id);
      const updatedSession: WorkspaceTerminalSession = {
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
  }): Promise<WorkspaceTerminalSession> {
    const binding = executionHostService.getBinding(options.host);
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const targetBinding: TerminalTargetBinding = {
      transport: options.host.kind === "ssh" ? "ssh" : "stdio",
      targetKey: binding.targetKey,
      workspaceRevision: 1,
      ...(options.host.kind === "mesh"
        ? { executionNodeId: options.host.nodeId }
        : {}),
    };
    const session: WorkspaceTerminalSession = {
      config: {
        id: sessionId,
        name: options.name.trim(),
        directory: options.directory.trim(),
        connectionMode: options.connectionMode,
        useTmux: options.useTmux,
        remoteSessionName: buildRemoteSessionName(sessionId),
        targetBinding,
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
    session: WorkspaceTerminalSession,
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
    taskId?: string;
    connectionMode: TerminalConnectionMode;
    useTmux: boolean;
  }): Promise<WorkspaceTerminalSession> {
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const targetBindings = await buildTargetBindings(options.workspace);
    const session: WorkspaceTerminalSession = {
      config: {
        id: sessionId,
        name: options.name,
        workspaceId: options.workspace.id,
        taskId: options.taskId,
        directory: options.directory,
        connectionMode: options.connectionMode,
        useTmux: options.useTmux,
        remoteSessionName: buildRemoteSessionName(sessionId),
        targetBinding: targetBindings.legacy,
        executionHostBinding: targetBindings.canonical,
        createdAt: now,
        updatedAt: now,
      },
      state: {
        status: "ready",
      },
    };

    try {
      await saveTerminalSession(session);
    } catch (error) {
      if (options.taskId && isUniqueConstraint(error, "terminal_sessions", "task_id")) {
        const existingSession = await getTerminalSessionByTaskId(options.taskId);
        if (existingSession) {
          return existingSession;
        }
      }
      throw error;
    }

    terminalSessionEventEmitter.emit({
      type: "terminal_session.created",
      terminalSessionId: session.config.id,
      session,
      timestamp: now,
    });
    return session;
  }

  private async requireSession(id: string): Promise<WorkspaceTerminalSession> {
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
    const identity = await managedContextIdentityResolver.forTerminalSession(
      currentSession.config.id,
      currentSession.config.workspaceId ?? currentSession.config.executionHostBinding!.targetKey,
    );
    await managedCredentialService.revokeContextIfConfigured(identity);

    const deleted = await deleteTerminalSession(id);
    if (deleted) {
      terminalSessionEventEmitter.emit({
        type: "terminal_session.deleted",
        terminalSessionId: id,
        timestamp: new Date().toISOString(),
      });
    }
    return deleted;
  }

  private async deletePersistentSessionBestEffort(session: WorkspaceTerminalSession): Promise<void> {
    if (!isPersistentTerminalSession(session)) {
      return;
    }

    try {
      const workspace = session.config.workspaceId
        ? await getWorkspace(session.config.workspaceId)
        : null;
      const executor = workspace
        ? await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory)
        : await executionHostService.getCommandExecutor(
            session.config.executionHostBinding!,
            {
              operationId: `terminal-cleanup:${session.config.id}`,
              directory: session.config.directory,
              provider: "copilot",
            },
          );
      // Reuse the same persistent session delete command, passing a compatible object
      const killResult = await executor.exec("bash", ["-lc", buildPersistentSessionDeleteCommand({
        config: {
          id: session.config.id,
          remoteSessionName: session.config.remoteSessionName,
        },
      })], {
        cwd: session.config.directory,
      });
      if (!killResult.success) {
        throw new Error(killResult.stderr.trim() || killResult.stdout.trim() || "Failed to stop remote persistent session");
      }
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
}

export const terminalSessionManager = new TerminalSessionManager();
