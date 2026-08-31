/**
 * Compatibility facade for the historical workspace SSH-session API.
 *
 * Canonical workspace sessions are owned by TerminalSessionManager. This
 * facade keeps old callers working while refusing to expose non-SSH targets.
 */

import type { SshSession, WorkspaceTerminalSession } from "@/shared";
import type { CreateSshSessionRequest, UpdateSshSessionRequest } from "@/contracts";
import { getWorkspace } from "../persistence/workspaces";
import {
  getSshSession,
  getSshSessionByTaskId,
  listSshSessions,
  listSshSessionsByWorkspace,
} from "../persistence/ssh-sessions";
import { loadTask } from "../persistence/tasks";
import { DomainError } from "./domain-error";
import { terminalSessionManager } from "./terminal-session-manager";

function toSshSession(session: WorkspaceTerminalSession): SshSession {
  return {
    config: {
      id: session.config.id,
      name: session.config.name,
      workspaceId: session.config.workspaceId,
      taskId: session.config.taskId,
      directory: session.config.directory,
      connectionMode: session.config.connectionMode,
      useTmux: session.config.useTmux,
      remoteSessionName: session.config.remoteSessionName,
      createdAt: session.config.createdAt,
      updatedAt: session.config.updatedAt,
      isPrivate: session.config.isPrivate,
    },
    state: {
      status: session.state.status,
      lastConnectedAt: session.state.lastConnectedAt,
      error: session.state.error,
      runtimeConnectionMode: session.state.runtimeConnectionMode,
      notice: session.state.notice,
    },
  };
}

function requireSshBoundSession(session: WorkspaceTerminalSession): SshSession {
  if (session.config.targetBinding.transport !== "ssh") {
    throw new DomainError(
      "ssh_transport_required",
      "SSH sessions require a workspace configured with ssh transport",
      { details: { workspaceId: session.config.workspaceId } },
    );
  }
  return toSshSession(session);
}

async function requireSshWorkspace(workspaceId: string): Promise<void> {
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
}

export class SshSessionManager {
  async listSessions(workspaceId?: string): Promise<SshSession[]> {
    return workspaceId
      ? await listSshSessionsByWorkspace(workspaceId)
      : await listSshSessions();
  }

  async getSession(id: string): Promise<SshSession | null> {
    return await getSshSession(id);
  }

  async getSessionByTaskId(taskId: string): Promise<SshSession | null> {
    return await getSshSessionByTaskId(taskId);
  }

  async createSession(request: CreateSshSessionRequest): Promise<SshSession> {
    await requireSshWorkspace(request.workspaceId);
    const session = await terminalSessionManager.createSession({
      workspaceId: request.workspaceId,
      name: request.name,
      connectionMode: request.connectionMode,
      useTmux: request.useTmux,
    }, { expectedTargetKind: "ssh" });
    return requireSshBoundSession(session);
  }

  async updateSession(id: string, request: UpdateSshSessionRequest): Promise<SshSession> {
    const currentSession = await terminalSessionManager.getSession(id);
    if (!currentSession) {
      throw new DomainError("terminal_session_not_found", "Terminal session not found", {
        details: { sessionId: id },
      });
    }
    requireSshBoundSession(currentSession);
    const session = await terminalSessionManager.updateSession(id, request);
    return requireSshBoundSession(session);
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = await terminalSessionManager.getSession(id);
    if (!session) {
      return false;
    }
    requireSshBoundSession(session);
    return await terminalSessionManager.deleteSession(id);
  }

  async getOrCreateTaskSession(taskId: string): Promise<SshSession> {
    const { taskManager } = await import("./task-manager");
    const task = await taskManager.getTask(taskId) ?? await loadTask(taskId);
    if (!task) {
      throw new DomainError("task_not_found", "Task not found", {
        details: { taskId },
      });
    }
    await requireSshWorkspace(task.config.workspaceId);
    const existing = await getSshSessionByTaskId(taskId);
    if (existing) {
      return existing;
    }
    const session = await terminalSessionManager.getOrCreateTaskSession(taskId, {
      expectedTargetKind: "ssh",
    });
    return requireSshBoundSession(session);
  }

  async deleteSessionByTaskId(taskId: string): Promise<boolean> {
    const session = await getSshSessionByTaskId(taskId);
    if (!session) {
      return false;
    }
    return await this.deleteSession(session.config.id);
  }

  async markStatus(id: string, status: SshSession["state"]["status"], error?: string): Promise<SshSession> {
    const currentSession = await terminalSessionManager.getSession(id);
    if (!currentSession) {
      throw new DomainError("terminal_session_not_found", "Terminal session not found", {
        details: { sessionId: id },
      });
    }
    requireSshBoundSession(currentSession);
    const session = await terminalSessionManager.markStatus(id, status, error);
    return requireSshBoundSession(session);
  }

  async updateRuntimeConnectionState(
    id: string,
    options: { runtimeConnectionMode?: SshSession["state"]["runtimeConnectionMode"]; notice?: string },
  ): Promise<SshSession> {
    const currentSession = await terminalSessionManager.getSession(id);
    if (!currentSession) {
      throw new DomainError("terminal_session_not_found", "Terminal session not found", {
        details: { sessionId: id },
      });
    }
    requireSshBoundSession(currentSession);
    const session = await terminalSessionManager.updateRuntimeConnectionState(id, options);
    return requireSshBoundSession(session);
  }
}

export const sshSessionManager = new SshSessionManager();
