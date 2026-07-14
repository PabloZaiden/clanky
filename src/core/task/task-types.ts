import type { CheapModelSelection, FollowUpPromptMode, Task, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { SshSession } from "@/shared/ssh-session";

/**
 * Options for creating a new task.
 */
export interface CreateTaskOptions {
  /** Human-readable task title */
  name: string;
  /** Absolute path to working directory */
  directory: string;
  /** The task prompt/PRD */
  prompt: string;
  /** Optional GitHub issue number linked to this task */
  issueNumber?: number;
  /** Transient image attachments for the initial prompt */
  attachments?: MessageImageAttachment[];
  /** Workspace ID this task belongs to */
  workspaceId: string;
  /** Model provider ID (required) */
  modelProviderID: string;
  /** Model ID (required) */
  modelID: string;
  /** Model variant (e.g., "thinking"). Empty string for default variant. */
  modelVariant?: string;
  /** Helper-model selection for cheap/lightweight non-task operations. */
  cheapModel?: CheapModelSelection;
  /** Maximum iterations (default: Infinity for unlimited) */
  maxIterations?: number;
  /** Maximum consecutive identical errors before failsafe exit (default: 10) */
  maxConsecutiveErrors?: number;
  /** Activity timeout in seconds - null means unlimited and is the default */
  activityTimeoutSeconds?: number | null;
  /** Custom stop pattern (default: "<promise>COMPLETE</promise>$") */
  stopPattern?: string;
  /** Git branch prefix (default: empty string) */
  gitBranchPrefix?: string;
  /** Git commit scope for conventional commits (default: empty string) */
  gitCommitScope?: string;
  /** Base branch to create the task from (default: current branch) */
  baseBranch?: string;
  /** Whether to create a dedicated worktree for the task (default: true) */
  useWorktree?: boolean;
  /** Clear the .clanky-planning folder contents before starting (default: false) */
  clearPlanningFolder?: boolean;
  /** Start in plan creation mode instead of immediate execution (required) */
  planMode: boolean;
  /** Whether a ready plan should be automatically accepted and executed */
  autoAcceptPlan?: boolean;
  /** Whether the accepted plan should continue into push and automatic PR flow */
  fullyAutonomous?: boolean;
  /** Save as draft without starting (no git branch or session created) */
  draft?: boolean;
}

/**
 * Options for starting a task.
 * Tasks use git worktrees for isolation, so uncommitted changes
 * in the main repository do not affect task execution.
 */
export interface StartTaskOptions {
  /** Transient image attachments for the first prompt sent after start */
  attachments?: MessageImageAttachment[];
}

export interface SeedPlanFilesOptions {
  planContent: string;
  statusContent?: string;
  planSourcePath?: string;
  statusSourcePath?: string;
}

export interface GenerateTaskTitleOptions {
  prompt: string;
  directory: string;
  workspaceId: string;
  model: ModelConfig;
  cheapModel?: CheapModelSelection;
}

export interface AcceptPlanOptions {
  mode?: "start_task" | "open_ssh";
  executionPrompt?: string;
  executionPromptMode?: FollowUpPromptMode;
}

export type AcceptPlanResult =
  | {
      mode: "start_task";
    }
  | {
      mode: "open_ssh";
      sshSession: SshSession;
    };

/**
 * Result of accepting a task.
 */
export interface AcceptTaskResult {
  success: boolean;
  error?: string;
}

export interface SendFollowUpResult {
  success: boolean;
  error?: string;
  reviewCycle?: number;
  branch?: string;
  commentIds?: string[];
}

export interface SendFollowUpOptions {
  message: string;
  model?: ModelConfig;
  attachments?: MessageImageAttachment[];
  promptMode?: FollowUpPromptMode;
}

/**
 * Result of pushing a task branch.
 */
export interface PushTaskResult {
  success: boolean;
  remoteBranch?: string;
  /** Sync status with base branch */
  syncStatus?: "already_up_to_date" | "clean" | "conflicts_being_resolved";
  error?: string;
}

/**
 * Resolve the effective working directory for a task.
 * Branch-only tasks run directly in the repository checkout, while
 * worktree-based tasks require a recorded worktree path.
 */
export function getTaskWorkingDirectory(task: Pick<Task, "config" | "state">): string | null {
  if (task.config.useWorktree) {
    return task.state.git?.worktreePath ?? null;
  }
  return task.config.directory;
}
