import type { ReactNode } from "react";
import type { ModelInfo, BranchInfo } from "../../types";
import type { CreateTaskFormSubmitRequest } from "../../types/task-request";
import type { ComposerImageAttachment } from "../../types/message-attachments";
import type { Workspace } from "../../types/workspace";
import type { CheapModelSelection } from "../../types";

/** State for action buttons, exposed via renderActions prop */
export interface CreateTaskFormActionState {
  /** Whether the form is currently submitting */
  isSubmitting: boolean;
  /** Whether the form can be submitted to start a task (create mode can auto-generate a missing title) */
  canSubmit: boolean;
  /** Whether the form can be saved as a draft (has required fields, model can be disconnected) */
  canSaveDraft: boolean;
  /** Whether we're editing an existing task */
  isEditing: boolean;
  /** Whether we're editing a draft task */
  isEditingDraft: boolean;
  /** Whether plan mode is enabled */
  planMode: boolean;
  /** Handler for cancel button */
  onCancel: () => void;
  /** Handler for submit button (creates/starts the task) */
  onSubmit: () => void;
  /** Handler for save as draft button */
  onSaveAsDraft: () => void;
}

export function getComposeDraftActionLabel(isEditingDraft: boolean): string {
  return isEditingDraft ? "Update" : "Save as Draft";
}

export function getComposeSubmitActionLabel({
  isEditing,
}: {
  isEditing: boolean;
}): string {
  return isEditing ? "Start" : "Create";
}

export interface CreateTaskFormProps {
  /** Callback when form is submitted. Returns true if successful, false otherwise. */
  onSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  /** Callback when form is cancelled */
  onCancel: () => void;
  /** Whether to call onCancel after a successful submit */
  closeOnSuccess?: boolean;
  /** Whether form is submitting */
  loading?: boolean;
  /** Available models */
  models?: ModelInfo[];
  /** Loading models */
  modelsLoading?: boolean;
  /** Last used model (includes variant) */
  lastModel?: { providerID: string; modelID: string; variant?: string } | null;
  /** Last used cheap helper-model selection */
  lastCheapModel?: CheapModelSelection | null;
  /** Callback when workspace changes (to reload models and branches) */
  onWorkspaceChange?: (workspaceId: string | null, directory: string) => void;
  /** Warning about the managed planning directory */
  planningWarning?: string | null;
  /** Available branches for the workspace's directory */
  branches?: BranchInfo[];
  /** Whether branches are loading */
  branchesLoading?: boolean;
  /** Current branch name */
  currentBranch?: string;
  /** Default branch name (e.g., "main" or "master") */
  defaultBranch?: string;
  /** Task ID if editing an existing draft */
  editTaskId?: string | null;
  /** Initial task data for editing */
  initialTaskData?: {
    name?: string;
    directory: string;
     prompt: string;
     model?: { providerID: string; modelID: string; variant?: string };
     cheapModel?: CheapModelSelection;
     maxIterations?: number;
    maxConsecutiveErrors?: number;
    activityTimeoutSeconds?: number | null;
    baseBranch?: string;
    useWorktree?: boolean;
    clearPlanningFolder?: boolean;
    planMode?: boolean;
    autoAcceptPlan?: boolean;
    fullyAutonomous?: boolean;
    workspaceId?: string;
  } | null;
  /** Whether editing a draft task (to show the Update button) */
  isEditingDraft?: boolean;
  /** Available workspaces */
  workspaces?: Workspace[];
  /** Whether workspaces are loading */
  workspacesLoading?: boolean;
  /** Workspace-related error */
  workspaceError?: string | null;
  /** Transient image attachments for the initial prompt */
  attachments?: ComposerImageAttachment[];
  /** 
   * Optional render prop for action buttons. When provided, action buttons 
   * are NOT rendered inside the form - caller is responsible for rendering them.
   * This is useful for rendering actions in a Modal footer (sticky position).
   */
  renderActions?: (state: CreateTaskFormActionState) => void;
  /** Optional extra actions rendered beside the draft/save action group. */
  leadingActions?: ReactNode;
}
