/**
 * Core manager for saved SSH sessions on workspace hosts.
 */

import { DEFAULT_SSH_CONNECTION_MODE, DEFAULT_SSH_SESSION_USE_TMUX, type SshConnectionMode, type SshSession, type SshSessionStatus, type Workspace } from "@/shared";
import { type CreateSshSessionRequest, type UpdateSshSessionRequest } from "@/contracts";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import {
  countSshSessionsByWorkspace,
  deleteSshSession,
  getSshSession,
  getSshSessionByTaskId,
  listSshSessions,
  listSshSessionsByWorkspace,
  saveSshSession,
} from "../persistence/ssh-sessions";
import { loadTask } from "../persistence/tasks";
import { backendManager } from "./backend-manager";
import { sshSessionEventEmitter } from "./event-emitter";
import { createLogger } from "./logger";
import { buildDefaultSshSessionName, buildTaskSshSessionName } from "../utils";
import { isPersistentSshSession } from "../utils";
import { buildPersistentSessionDeleteCommand } from "./ssh-persistent-session";
import { isUniqueConstraint } from "../persistence/errors";
import { DomainError } from "./domain-error";

const log = createLogger("core:ssh-session-manager");

function buildRemoteSessionName(id: string): string {
  return `clanky-${id.replace(/-/g, "").slice(0, 24)}`;
}

async function requireSshWorkspace(workspaceId: string): Promise<Workspace> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", "Workspace not found", {
      details: { workspaceId },
    });
  }
  if (workspace.serverSettings.agent.transport !== "ssh") {
    throw new DomainError(
      "ssh_transport_required",
      "SSH sessions require a workspace configured with ssh transport",
      { details: { workspaceId } },
    );
  }
  return workspace;
}

export class SshSessionManager {
  async listSessions(workspaceId?: string): Promise<SshSession[]> {
    if (workspaceId) {
      return await listSshSessionsByWorkspace(workspaceId);
    }
    return await listSshSessions();
  }

  async getSession(id: string): Promise<SshSession | null> {
    return await getSshSession(id);
  }

  async getSessionByTaskId(taskId: string): Promise<SshSession | null> {
    return await getSshSessionByTaskId(taskId);
  }

  async createSession(request: CreateSshSessionRequest): Promise<SshSession> {
    const workspace = await requireSshWorkspace(request.workspaceId);
    const connectionMode = request.connectionMode ?? DEFAULT_SSH_CONNECTION_MODE;
    const useTmux = request.useTmux ?? DEFAULT_SSH_SESSION_USE_TMUX;
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
  }

  async updateSession(id: string, request: UpdateSshSessionRequest): Promise<SshSession> {
    const session = await this.requireSession(id);
    const updatedSession: SshSession = {
      config: {
        ...session.config,
        ...(request.name !== undefined ? { name: request.name.trim() } : {}),
        ...(request.isPrivate !== undefined ? { isPrivate: request.isPrivate } : {}),
        updatedAt: new Date().toISOString(),
      },
      state: session.state,
    };
    await saveSshSession(updatedSession);
    sshSessionEventEmitter.emit({
      type: "ssh_session.updated",
      sshSessionId: updatedSession.config.id,
      session: updatedSession,
      timestamp: updatedSession.config.updatedAt,
    });
    return updatedSession;
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = await this.requireSession(id);
    await this.deletePersistentSessionBestEffort(session);

    const deleted = await deleteSshSession(id);
    if (deleted) {
      sshSessionEventEmitter.emit({
        type: "ssh_session.deleted",
        sshSessionId: id,
        timestamp: new Date().toISOString(),
      });
    }
    return deleted;
  }

  async getOrCreateTaskSession(taskId: string): Promise<SshSession> {
    const existingSession = await getSshSessionByTaskId(taskId);
    if (existingSession) {
      return existingSession;
    }

    const { taskManager } = await import("./task-manager");
    const task = await taskManager.getTask(taskId) ?? await loadTask(taskId);
    if (!task) {
      throw new DomainError("task_not_found", "Task not found", {
        details: { taskId },
      });
    }

    const workspace = await requireSshWorkspace(task.config.workspaceId);
    await touchWorkspace(workspace.id);

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
      workspace,
      name: buildTaskSshSessionName(task.config.name),
      directory,
      taskId,
      connectionMode: DEFAULT_SSH_CONNECTION_MODE,
      useTmux: DEFAULT_SSH_SESSION_USE_TMUX,
    });
  }

  async deleteSessionByTaskId(taskId: string): Promise<boolean> {
    const session = await getSshSessionByTaskId(taskId);
    if (!session) {
      return false;
    }
    return await this.deleteSession(session.config.id);
  }

  async markStatus(id: string, status: SshSessionStatus, error?: string): Promise<SshSession> {
    const session = await this.requireSession(id);
    const updatedSession: SshSession = {
      config: {
        ...session.config,
        updatedAt: new Date().toISOString(),
      },
      state: {
        ...session.state,
        status,
        error: error?.trim() || undefined,
        lastConnectedAt: status === "connected"
          ? new Date().toISOString()
          : session.state.lastConnectedAt,
      },
    };
    await saveSshSession(updatedSession);
    sshSessionEventEmitter.emit({
      type: "ssh_session.status",
      sshSessionId: id,
      status,
      error: updatedSession.state.error,
      timestamp: updatedSession.config.updatedAt,
    });
    return updatedSession;
  }

  async updateRuntimeConnectionState(
    id: string,
    options: { runtimeConnectionMode?: SshConnectionMode; notice?: string },
  ): Promise<SshSession> {
    const session = await this.requireSession(id);
    const updatedSession: SshSession = {
      config: {
        ...session.config,
        updatedAt: new Date().toISOString(),
      },
      state: {
        ...session.state,
        runtimeConnectionMode: options.runtimeConnectionMode,
        notice: options.notice?.trim() || undefined,
      },
    };
    await saveSshSession(updatedSession);
    sshSessionEventEmitter.emit({
      type: "ssh_session.updated",
      sshSessionId: updatedSession.config.id,
      session: updatedSession,
      timestamp: updatedSession.config.updatedAt,
    });
    return updatedSession;
  }

  private async buildDefaultSessionName(workspace: Workspace): Promise<string> {
    const existingSessionCount = await countSshSessionsByWorkspace(workspace.id);
    return buildDefaultSshSessionName(workspace.name, existingSessionCount);
  }

  private async createAndSaveSession(options: {
    workspace: Workspace;
    name: string;
    directory: string;
    taskId?: string;
    connectionMode: SshConnectionMode;
    useTmux: boolean;
  }): Promise<SshSession> {
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const session: SshSession = {
      config: {
        id: sessionId,
        name: options.name,
        workspaceId: options.workspace.id,
        taskId: options.taskId,
        directory: options.directory,
        connectionMode: options.connectionMode,
        useTmux: options.useTmux,
        remoteSessionName: buildRemoteSessionName(sessionId),
        createdAt: now,
        updatedAt: now,
      },
      state: {
        status: "ready",
      },
    };

    try {
      await saveSshSession(session);
    } catch (error) {
      if (options.taskId && isUniqueConstraint(error, "ssh_sessions", "task_id")) {
        const existingSession = await getSshSessionByTaskId(options.taskId);
        if (existingSession) {
          return existingSession;
        }
      }
      throw error;
    }

    sshSessionEventEmitter.emit({
      type: "ssh_session.created",
      sshSessionId: session.config.id,
      session,
      timestamp: now,
    });
    return session;
  }

  private async requireSession(id: string): Promise<SshSession> {
    const session = await getSshSession(id);
    if (!session) {
      throw new DomainError("ssh_session_not_found", "SSH session not found", {
        details: { sessionId: id },
      });
    }
    return session;
  }

  private async deletePersistentSessionBestEffort(session: SshSession): Promise<void> {
    if (!isPersistentSshSession(session)) {
      return;
    }

    const workspace = await getWorkspace(session.config.workspaceId);
    if (!workspace) {
      return;
    }

    if (workspace.serverSettings.agent.transport !== "ssh") {
      return;
    }

    try {
      const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
      const killResult = await executor.exec("bash", ["-lc", buildPersistentSessionDeleteCommand(session)], {
        cwd: workspace.directory,
      });
      if (!killResult.success) {
        throw new Error(killResult.stderr.trim() || killResult.stdout.trim() || "Failed to stop remote persistent SSH session");
      }
    } catch (error) {
      log.warn("Failed to stop remote persistent SSH session during deletion", {
        sshSessionId: session.config.id,
        workspaceId: session.config.workspaceId,
        remoteSessionName: session.config.remoteSessionName,
        status: session.state.status,
        error: String(error),
      });
    }
  }
}

export const sshSessionManager = new SshSessionManager();
