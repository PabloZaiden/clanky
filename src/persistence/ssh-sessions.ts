/**
 * Compatibility adapter for the historical workspace SSH-session API.
 *
 * Workspace sessions are stored exclusively in terminal_sessions. This
 * adapter intentionally exposes only sessions bound to an SSH workspace.
 */

import type { SshSession, WorkspaceTerminalSession } from "@/shared";
import { getWorkspace } from "./workspaces";
import { buildSshTargetKey } from "./workspace-target-key";
import {
  deleteTerminalSession,
  getTerminalSession,
  getTerminalSessionByTaskId,
  listTerminalSessions,
  listTerminalSessionsByWorkspace,
  saveTerminalSession,
} from "./terminal-sessions";
import { DomainError } from "../domain/domain-error";

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

function requireSshBoundSession(session: WorkspaceTerminalSession | null): WorkspaceTerminalSession | null {
  if (!session || session.config.targetBinding.transport !== "ssh") {
    return null;
  }
  return session;
}

async function withSshTarget(
  session: SshSession,
): Promise<WorkspaceTerminalSession> {
  const workspace = await getWorkspace(session.config.workspaceId);
  if (!workspace) {
    throw new DomainError("workspace_not_found", "Workspace not found", {
      details: { workspaceId: session.config.workspaceId },
    });
  }
  const agent = workspace.serverSettings.agent;
  if (agent.transport !== "ssh") {
    throw new DomainError(
      "ssh_transport_required",
      "SSH sessions require a workspace configured with ssh transport",
      { details: { workspaceId: workspace.id } },
    );
  }
  const host = agent.hostname.trim();
  if (!host) {
    throw new DomainError(
      "ssh_transport_required",
      "SSH settings require a hostname",
      { details: { workspaceId: workspace.id } },
    );
  }
  const port = agent.port ?? 22;
  const username = agent.username?.trim() || undefined;
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
      targetBinding: {
        transport: "ssh",
        targetKey: buildSshTargetKey(host, port, username),
        workspaceRevision: workspace.executionTargetRevision ?? 1,
        hostname: host,
        port,
        username,
      },
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

export async function saveSshSession(session: SshSession): Promise<void> {
  await saveTerminalSession(await withSshTarget(session));
}

export async function getSshSession(id: string): Promise<SshSession | null> {
  const session = requireSshBoundSession(await getTerminalSession(id));
  return session ? toSshSession(session) : null;
}

export async function listSshSessions(): Promise<SshSession[]> {
  const sessions = await listTerminalSessions();
  return sessions.filter((session) => session.config.targetBinding.transport === "ssh").map(toSshSession);
}

export async function listSshSessionsByWorkspace(workspaceId: string): Promise<SshSession[]> {
  const sessions = await listTerminalSessionsByWorkspace(workspaceId);
  return sessions.filter((session) => session.config.targetBinding.transport === "ssh").map(toSshSession);
}

export async function getSshSessionByTaskId(taskId: string): Promise<SshSession | null> {
  const session = requireSshBoundSession(await getTerminalSessionByTaskId(taskId));
  return session ? toSshSession(session) : null;
}

export async function countSshSessionsByWorkspace(workspaceId: string): Promise<number> {
  return (await listSshSessionsByWorkspace(workspaceId)).length;
}

export async function deleteSshSession(id: string): Promise<boolean> {
  const session = requireSshBoundSession(await getTerminalSession(id));
  if (!session) {
    return false;
  }
  return await deleteTerminalSession(id);
}
