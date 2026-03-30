import type { Loop } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { SshSession } from "../../types/ssh-session";

/**
 * Options for creating a new loop.
 */
export interface CreateLoopOptions {
  /** Human-readable loop title */
  name: string;
  /** Absolute path to working directory */
  directory: string;
  /** The task prompt/PRD */
  prompt: string;
  /** Transient image attachments for the initial prompt */
  attachments?: MessageImageAttachment[];
  /** Workspace ID this loop belongs to */
  workspaceId: string;
  /** Model provider ID (required) */
  modelProviderID: string;
  /** Model ID (required) */
  modelID: string;
  /** Model variant (e.g., "thinking"). Empty string for default variant. */
  modelVariant?: string;
  /** Maximum iterations (default: Infinity for unlimited) */
  maxIterations?: number;
  /** Maximum consecutive identical errors before failsafe exit (default: 10) */
  maxConsecutiveErrors?: number;
  /** Activity timeout in seconds - time without events before treating as error (default: 900 = 15 minutes) */
  activityTimeoutSeconds?: number;
  /** Custom stop pattern (default: "<promise>COMPLETE</promise>$") */
  stopPattern?: string;
  /** Git branch prefix (default: empty string) */
  gitBranchPrefix?: string;
  /** Git commit scope for conventional commits (default: empty string) */
  gitCommitScope?: string;
  /** Base branch to create the loop from (default: current branch) */
  baseBranch?: string;
  /** Whether to create a dedicated worktree for the loop (default: true) */
  useWorktree?: boolean;
  /** Clear the .planning folder contents before starting (default: false) */
  clearPlanningFolder?: boolean;
  /** Start in plan creation mode instead of immediate execution (required) */
  planMode: boolean;
  /** Whether plan-mode questions should be auto-answered instead of shown inline */
  planModeAutoReply?: boolean;
  /** Save as draft without starting (no git branch or session created) */
  draft?: boolean;
}

/**
 * Options for starting a loop.
 * Loops use git worktrees for isolation, so uncommitted changes
 * in the main repository do not affect loop execution.
 */
export interface StartLoopOptions {
  /** Transient image attachments for the first prompt sent after start */
  attachments?: MessageImageAttachment[];
}

export interface AcceptPlanOptions {
  mode?: "start_loop" | "open_ssh";
}

export type AcceptPlanResult =
  | {
      mode: "start_loop";
    }
  | {
      mode: "open_ssh";
      sshSession: SshSession;
    };

/**
 * Result of accepting a loop.
 */
export interface AcceptLoopResult {
  success: boolean;
  mergeCommit?: string;
  error?: string;
}

export interface SendFollowUpResult {
  success: boolean;
  error?: string;
  reviewCycle?: number;
  branch?: string;
  commentIds?: string[];
}

/**
 * Result of pushing a loop branch.
 */
export interface PushLoopResult {
  success: boolean;
  remoteBranch?: string;
  /** Sync status with base branch */
  syncStatus?: "already_up_to_date" | "clean" | "conflicts_being_resolved";
  error?: string;
}

/**
 * Resolve the effective working directory for a loop.
 * Branch-only loops run directly in the repository checkout, while
 * worktree-based loops require a recorded worktree path.
 */
export function getLoopWorkingDirectory(loop: Pick<Loop, "config" | "state">): string | null {
  if (loop.config.useWorktree) {
    return loop.state.git?.worktreePath ?? null;
  }
  return loop.config.directory;
}
