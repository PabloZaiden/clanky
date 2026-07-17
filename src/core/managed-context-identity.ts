/**
 * Resolves persisted Clanky entities to stable managed-credential identities.
 */

import type { ManagedContextIdentity, ManagedContextType } from "@/shared/context-api-key";
import { loadAgentRun, loadAgentRunByChatId } from "../persistence/agents";
import { loadChat } from "../persistence/chats";
import { loadTask } from "../persistence/tasks";
import { getSshSession } from "../persistence/ssh-sessions";
import { DomainError } from "./domain-error";
import { requireCurrentUserId } from "./user-context";

function missingContext(contextType: ManagedContextType, contextId: string): DomainError {
  return new DomainError("managed_context_not_found", "Managed execution context was not found", {
    details: { contextType, contextId },
  });
}

function ensureWorkspace(
  contextType: ManagedContextType,
  contextId: string,
  actualWorkspaceId: string,
  expectedWorkspaceId?: string,
): string {
  if (!actualWorkspaceId) {
    throw new DomainError("managed_context_workspace_missing", "Managed execution context has no workspace", {
      details: { contextType, contextId },
    });
  }
  if (expectedWorkspaceId !== undefined && actualWorkspaceId !== expectedWorkspaceId) {
    throw new DomainError("managed_context_workspace_mismatch", "Managed execution context belongs to another workspace", {
      details: { contextType, contextId, expectedWorkspaceId, actualWorkspaceId },
    });
  }
  return actualWorkspaceId;
}

export class ManagedContextIdentityResolver {
  async forTask(taskId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const task = await loadTask(taskId);
    if (!task) {
      throw missingContext("task", taskId);
    }
    return this.createIdentity(
      "task",
      taskId,
      ensureWorkspace("task", taskId, task.config.workspaceId, expectedWorkspaceId),
    );
  }

  async forChat(chatId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const chat = await loadChat(chatId);
    if (!chat) {
      throw missingContext("chat", chatId);
    }

    if (chat.config.scope === "task" && chat.config.taskId) {
      return await this.forTask(chat.config.taskId, expectedWorkspaceId ?? chat.config.workspaceId);
    }

    if (chat.config.scope === "agent") {
      const run = await loadAgentRunByChatId(chatId);
      if (!run) {
        throw missingContext("agent_run", chatId);
      }
      return this.createIdentity(
        "agent_run",
        run.id,
        ensureWorkspace("agent_run", run.id, run.configSnapshot.workspaceId, expectedWorkspaceId),
      );
    }

    return this.createIdentity(
      "chat",
      chatId,
      ensureWorkspace("chat", chatId, chat.config.workspaceId, expectedWorkspaceId),
    );
  }

  async forAgentRun(runId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const run = await loadAgentRun(runId);
    if (!run) {
      throw missingContext("agent_run", runId);
    }
    return this.createIdentity(
      "agent_run",
      runId,
      ensureWorkspace("agent_run", runId, run.configSnapshot.workspaceId, expectedWorkspaceId),
    );
  }

  async forSshSession(sessionId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const session = await getSshSession(sessionId);
    if (!session) {
      throw missingContext("ssh_session", sessionId);
    }
    return this.createIdentity(
      "ssh_session",
      sessionId,
      ensureWorkspace("ssh_session", sessionId, session.config.workspaceId, expectedWorkspaceId),
    );
  }

  private createIdentity(
    contextType: ManagedContextType,
    contextId: string,
    workspaceId: string,
  ): ManagedContextIdentity {
    return {
      userId: requireCurrentUserId(),
      workspaceId,
      contextType,
      contextId,
    };
  }
}

export const managedContextIdentityResolver = new ManagedContextIdentityResolver();
