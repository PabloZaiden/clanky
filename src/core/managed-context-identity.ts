/**
 * Resolves persisted Clanky entities to stable execution identities.
 */

import type { ManagedContextIdentity, ManagedContextType } from "@/shared/context-api-key";
import { getChatWorkspaceId, type Chat } from "@/shared/chat";
import { loadAutomationRunSummary, loadAutomationRunSummaryByChatId } from "../persistence/automations";
import { loadChatMetadata } from "../persistence/chats";
import { getTerminalSession } from "../persistence/terminal-sessions";
import { DomainError } from "../domain/domain-error";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { getWorkspace } from "../persistence/workspaces";
import { isAutomationRunActiveStatus } from "@/shared/automation";

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
  async forChat(chatId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const chat = await loadChatMetadata(chatId);
    if (!chat) {
      throw missingContext("chat", chatId);
    }
    return await this.forChatSnapshot(chat, expectedWorkspaceId);
  }

  async forChatSnapshot(chat: Pick<Chat, "config">, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const chatId = chat.config.id;
    if (chat.config.scope === "automation") {
      const run = await loadAutomationRunSummaryByChatId(chatId);
      if (run) {
        return this.createIdentity(
          "automation_run",
          run.id,
          ensureWorkspace("automation_run", run.id, run.configSnapshot.workspaceId, expectedWorkspaceId),
        );
      }
      // Persistent automation-generation chats use the automation scope without an
      // AutomationRun, so their lifecycle is managed like a standalone chat.
    }

    return this.createIdentity(
      "chat",
      chatId,
      ensureWorkspace("chat", chatId, getChatWorkspaceId(chat), expectedWorkspaceId),
    );
  }

  async forAutomationRun(runId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const run = await loadAutomationRunSummary(runId);
    if (!run) {
      throw missingContext("automation_run", runId);
    }
    return this.createIdentity(
      "automation_run",
      runId,
      ensureWorkspace("automation_run", runId, run.configSnapshot.workspaceId, expectedWorkspaceId),
    );
  }

  async forTerminalSession(sessionId: string, expectedWorkspaceId?: string): Promise<ManagedContextIdentity> {
    const session = await getTerminalSession(sessionId);
    if (!session) {
      throw missingContext("terminal_session", sessionId);
    }
    if (!session.config.workspaceId) {
      throw new DomainError(
        "managed_context_workspace_required",
        "Direct execution-host terminal sessions do not have a workspace context.",
      );
    }
    return this.createIdentity(
      "terminal_session",
      sessionId,
      ensureWorkspace("terminal_session", sessionId, session.config.workspaceId, expectedWorkspaceId),
    );
  }

  async isActive(identity: ManagedContextIdentity): Promise<boolean> {
    if (identity.userId !== requireExecutionOwnerUserId() || !await getWorkspace(identity.workspaceId)) return false;
    switch (identity.contextType) {
      case "chat": {
        const chat = await loadChatMetadata(identity.contextId);
        return chat?.config.workspaceId === identity.workspaceId;
      }
      case "automation_run": {
        const run = await loadAutomationRunSummary(identity.contextId);
        return run?.configSnapshot.workspaceId === identity.workspaceId && isAutomationRunActiveStatus(run.status);
      }
      case "terminal_session": {
        const session = await getTerminalSession(identity.contextId);
        return session?.config.workspaceId === identity.workspaceId;
      }
    }
  }

  private createIdentity(
    contextType: ManagedContextType,
    contextId: string,
    workspaceId: string,
  ): ManagedContextIdentity {
    return {
      userId: requireExecutionOwnerUserId(),
      workspaceId,
      contextType,
      contextId,
    };
  }
}

export const managedContextIdentityResolver = new ManagedContextIdentityResolver();
