import type { ManagedContextType } from "@/shared/context-api-key";

export interface ContextApiKeyAssociation {
  userId: string;
  workspaceId: string;
  contextType: ManagedContextType;
  contextId: string;
  apiKeyId: string;
  generation: number;
  createdAt: string;
  revokedAt?: string;
}

export type NewContextApiKeyAssociation = Omit<
  ContextApiKeyAssociation,
  "userId" | "createdAt" | "revokedAt"
> & {
  createdAt?: string;
  revokedAt?: string;
};
