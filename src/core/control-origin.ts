import type { ClankyControlContext } from "@/shared/clanky-control";
import { ModelConfigSchema } from "@/contracts/schemas/model";
import type { ControlGrant } from "./control-authority";
import type { ControlToolOrigin } from "./control-tool-context";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { loadChatMetadata } from "../persistence/chats";
import { loadTask } from "../persistence/tasks";
import { loadAgentRun } from "../persistence/agents";
import { DomainError } from "../domain/domain-error";

export async function requireControlChat(grant: ControlGrant, chatId: string): Promise<void> {
  const expected = grant.managedContext;
  const chat = await loadChatMetadata(chatId);
  if (!expected || !chat) {
    throw new DomainError("control_origin_invalid", "Browser provenance requires the credential's actual managed chat.");
  }
  const actual = await managedContextIdentityResolver.forChatSnapshot(chat, expected.workspaceId);
  if (actual.contextType !== expected.contextType || actual.contextId !== expected.contextId
    || actual.userId !== expected.userId) {
    throw new DomainError("control_origin_invalid", "Browser provenance does not match the managed execution.");
  }
}

export async function resolveControlOrigin(
  grant: ControlGrant, browser?: ClankyControlContext,
): Promise<ControlToolOrigin> {
  const origin: ControlToolOrigin = {
    ...(grant.workspaceId ? { workspaceId: grant.workspaceId } : {}),
    current: { ...(grant.workspaceId ? { workspace: grant.workspaceId } : {}) },
  };
  const identity = grant.managedContext;
  if (identity?.contextType === "chat") {
    const chat = await loadChatMetadata(identity.contextId);
    if (!chat) throw new DomainError("control_context_unavailable", "The originating chat is unavailable.");
    origin.current.chat = chat.config.id;
    origin.defaultModel = chat.config.model;
  } else if (identity?.contextType === "task") {
    const task = await loadTask(identity.contextId);
    if (!task) throw new DomainError("control_context_unavailable", "The originating task is unavailable.");
    origin.current.task = task.config.id;
    origin.defaultModel = task.config.model;
    origin.planningPreferences = {
      autoAcceptPlan: task.config.autoAcceptPlan === true,
      fullyAutonomous: task.config.fullyAutonomous === true,
    };
  } else if (identity?.contextType === "agent_run") {
    const run = await loadAgentRun(identity.contextId);
    if (!run) throw new DomainError("control_context_unavailable", "The originating agent run is unavailable.");
    origin.defaultModel = run.configSnapshot.model;
    if (run.chatId) origin.current.chat = run.chatId;
  }
  if (browser) {
    await requireControlChat(grant, browser.chatId);
    if (browser.workspaceId !== grant.workspaceId) {
      throw new DomainError("control_origin_invalid", "Browser provenance names another workspace.");
    }
    origin.current.chat = browser.chatId;
    origin.defaultModel = ModelConfigSchema.parse(browser.defaultModel);
  }
  return origin;
}
