/**
 * Stable execution-context identities and external credential scopes.
 */

export const MANAGED_CONTEXT_TYPES = ["task", "chat", "agent_run", "terminal_session"] as const;

export type ManagedContextType = typeof MANAGED_CONTEXT_TYPES[number];

export const CLANKY_CONTROL_SCOPE = "clanky:control";
export const CLANKY_CONTROL_GENERAL_SCOPE = "clanky:control:general";

export function controlWorkspaceScope(workspaceId: string): string {
  return `clanky:control:workspace:${workspaceId}`;
}

export interface ManagedContextIdentity {
  userId: string;
  workspaceId: string;
  contextType: ManagedContextType;
  contextId: string;
}
