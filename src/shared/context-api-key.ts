/**
 * Stable execution-context types used by Clanky's managed API-key
 * associations.
 */

export const MANAGED_CONTEXT_TYPES = ["task", "chat", "agent_run", "ssh_session"] as const;

export type ManagedContextType = typeof MANAGED_CONTEXT_TYPES[number];

export interface ManagedContextIdentity {
  userId: string;
  workspaceId: string;
  contextType: ManagedContextType;
  contextId: string;
}
