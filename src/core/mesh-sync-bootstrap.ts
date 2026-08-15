/**
 * Creates current SSH-only snapshots for a newly joined mesh peer.
 *
 * Existing resources may predate the link and therefore have no checkpoint.
 * Bootstrap materializes those resources through the normal checkpoint path,
 * so the same merge, outbox, and retry semantics apply to both old and new
 * data.
 */

import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { getDatabase } from "../persistence/database";
import {
  listWorkspaces,
  getWorkspaceMeshPayload,
} from "../persistence/workspaces";
import {
  listTasksForUser,
} from "../persistence/tasks";
import {
  listAgents,
  listAgentRuns,
  loadAgentRun,
} from "../persistence/agents";
import {
  loadChat,
} from "../persistence/chats";
import {
  listSshServerConfigs,
  getSshServerMeshPayload,
  listSshServerSessionsByServerId,
} from "../persistence/ssh-servers";
import {
  listSshSessions,
} from "../persistence/ssh-sessions";
import { getMeshLinkForLocalUser } from "../persistence/mesh";
import {
  isMeshAggregateEligible,
  recordMeshCheckpoint,
} from "../persistence/mesh-sync";
import { runWithCurrentUser } from "./user-context";
import type { MeshSyncAggregateType } from "@/shared/mesh";
import type { Agent, AgentRun } from "@/shared/agent";
import type { Chat, Task } from "@/shared";
import type { SshServerSession, SshSession } from "@/shared";

interface ReviewCommentSnapshot {
  id: string;
  taskId: string;
  reviewCycle: number;
  commentText: string;
  createdAt: string;
  status: string;
  addressedAt: string | null;
}

async function recordIfEligible(
  userId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  payload: unknown,
): Promise<void> {
  if (!isMeshAggregateEligible(userId, aggregateType, aggregateId)) {
    return;
  }
  await recordMeshCheckpoint({
    userId,
    aggregateType,
    aggregateId,
    payload,
  });
}

async function recordReviewComments(userId: string): Promise<void> {
  const rows = getDatabase().query(`
    SELECT comment.id, comment.task_id, comment.review_cycle, comment.comment_text,
      comment.created_at, comment.status, comment.addressed_at
    FROM review_comments AS comment
    WHERE comment.user_id = ?
    ORDER BY comment.created_at ASC, comment.id ASC
  `).all(userId) as ReviewCommentSnapshot[];
  for (const row of rows) {
    await recordIfEligible(userId, "review_comment", row.id, row);
  }
}

async function createCurrentUserSnapshots(user: CurrentUser): Promise<void> {
  const userId = user.id;
  if (!await getMeshLinkForLocalUser(userId)) {
    return;
  }

  const workspaces = await listWorkspaces();
  for (const workspace of workspaces) {
    await recordIfEligible(userId, "workspace", workspace.id, await getWorkspaceMeshPayload(workspace));
  }

  const tasks = await listTasksForUser(userId);
  for (const task of tasks) {
    await recordIfEligible(userId, "task", task.config.id, task as Task);
  }

  const chatRows = getDatabase().query("SELECT id FROM chats WHERE user_id = ? ORDER BY created_at ASC, id ASC")
    .all(userId) as Array<{ id: string }>;
  for (const row of chatRows) {
    const chat = await loadChat(row.id);
    if (chat) {
      await recordIfEligible(userId, "chat", row.id, chat as Chat);
    }
  }

  const agents = await listAgents();
  for (const agent of agents) {
    await recordIfEligible(userId, "agent", agent.config.id, agent as Agent);
    for (const run of await listAgentRuns(agent.config.id)) {
      const hydrated = await loadAgentRun(run.id);
      await recordIfEligible(userId, "agent_run", run.id, (hydrated ?? run) as AgentRun);
    }
  }

  const servers = await listSshServerConfigs();
  for (const server of servers) {
    await recordIfEligible(
      userId,
      "ssh_server",
      server.id,
      await getSshServerMeshPayload(server),
    );
    for (const session of await listSshServerSessionsByServerId(server.id)) {
      await recordIfEligible(
        userId,
        "ssh_server_session",
        session.config.id,
        session as SshServerSession,
      );
    }
  }

  for (const session of await listSshSessions()) {
    await recordIfEligible(userId, "ssh_session", session.config.id, session as SshSession);
  }

  await recordReviewComments(userId);
}

export async function bootstrapMeshPeer(user: CurrentUser): Promise<void> {
  await runWithCurrentUser(user, async () => {
    await createCurrentUserSnapshots(user);
  });
}

export async function bootstrapMeshPeerForUser(localUserId: string): Promise<void> {
  const row = getDatabase().query(`
    SELECT id, username, role
    FROM webapp_users
    WHERE id = ?
  `).get(localUserId) as { id: string; username: string; role: string } | null;
  if (!row) {
    throw new Error(`Local mesh user not found: ${localUserId}`);
  }
  const role = row.role as CurrentUser["role"];
  await bootstrapMeshPeer({
    id: row.id,
    username: row.username,
    role,
    isOwner: role === "owner",
    isAdmin: role === "owner" || role === "admin",
  });
}
