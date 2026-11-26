export interface RepositoryBaseSelection {
  repository: string;
  ref: string;
  identity?: string;
}

export interface WorkspaceRepository {
  name: string;
  identity: string;
  defaultRef: string | null;
  refs: string[];
}

export interface ChatRepositoryWorktree {
  name: string;
  identity: string;
  baseRef: string;
  baseCommit: string;
  baseSyncWarning?: string;
}

export interface ChatWorktreeGroup {
  ownerChatId: string;
  sourceDirectory: string;
  sourceIdentity: string;
  branch: string;
  repositories: ChatRepositoryWorktree[];
}
