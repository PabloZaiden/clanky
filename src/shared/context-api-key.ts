/**
 * Stable execution-context types used by Clanky's managed API-key
 * associations.
 */

export const MANAGED_CONTEXT_TYPES = ["task", "chat", "agent_run", "terminal_session"] as const;

export type ManagedContextType = typeof MANAGED_CONTEXT_TYPES[number];

export const AGENT_PROMPT_SCOPE = "clanky:agent-prompt";

export function agentPromptChatScope(chatId: string): string {
  return `${AGENT_PROMPT_SCOPE}:${chatId}`;
}

export interface ManagedContextIdentity {
  userId: string;
  workspaceId: string;
  contextType: ManagedContextType;
  contextId: string;
}
