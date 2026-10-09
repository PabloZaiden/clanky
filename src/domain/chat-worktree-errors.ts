import { DomainError } from "./domain-error";

export const CHAT_WORKTREE_BRANCH_CONFLICT_CODE = "chat_worktree_branch_conflict" as const;

export class ChatWorktreeBranchConflictError extends DomainError<
  typeof CHAT_WORKTREE_BRANCH_CONFLICT_CODE
> {
  constructor(branchName: string) {
    super(
      CHAT_WORKTREE_BRANCH_CONFLICT_CODE,
      `The chat worktree branch "${branchName}" is already checked out or reserved.`,
      { details: { branchName } },
    );
    this.name = "ChatWorktreeBranchConflictError";
  }
}
