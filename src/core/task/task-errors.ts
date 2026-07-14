import { DomainError, type DomainErrorOptions } from "../domain-error";

/**
 * Stable failure codes returned by task operations.
 *
 * Messages remain presentation text. Callers must branch on these codes and
 * use details for any additional structured state.
 */
export type TaskErrorCode =
  | "task_not_found"
  | "task_not_running"
  | "task_not_planning"
  | "plan_not_ready"
  | "task_already_running"
  | "invalid_task_state"
  | "invalid_model_config"
  | "task_branch_missing"
  | "task_worktree_missing"
  | "operation_in_progress"
  | "invalid_task_input"
  | "task_not_addressable"
  | "automatic_pr_flow_disabled"
  | "automatic_pr_flow_busy"
  | "task_no_remote"
  | "task_operation_failed"
  | "task_git_operation_failed"
  | "task_ssh_session_failed"
  | "task_file_operation_failed"
  | "task_session_reconnect_failed"
  | "uncommitted_changes"
  | "directory_in_use";

export const TASK_GIT_OPERATION_FAILURE_MESSAGE = "Task git operation failed";

export type TaskUpdateErrorCode =
  | "base_branch_immutable"
  | "use_worktree_immutable"
  | "active_task_update_restricted"
  | "planning_update_restricted"
  | "plan_execution_update_restricted"
  | "task_rename_restricted";

export class TaskOperationError<
  TCode extends TaskErrorCode = TaskErrorCode,
> extends DomainError<TCode> {
  constructor(
    code: TCode,
    message: string,
    options: DomainErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "TaskOperationError";
  }
}

export class TaskUpdateError<
  TCode extends TaskUpdateErrorCode = TaskUpdateErrorCode,
> extends DomainError<TCode> {
  constructor(code: TCode, message: string, options: DomainErrorOptions = {}) {
    super(code, message, options);
    this.name = "TaskUpdateError";
  }
}

export type TaskFailure<TCode extends TaskErrorCode = TaskErrorCode> = {
  success: false;
  error: TaskOperationError<TCode>;
};

export type TaskResult<TData extends object = Record<never, never>> =
  | ({ success: true } & TData)
  | TaskFailure;

export function taskFailure<TCode extends TaskErrorCode>(
  code: TCode,
  message: string,
  options: DomainErrorOptions = {},
): TaskFailure<TCode> {
  return {
    success: false,
    error: new TaskOperationError(code, message, options),
  };
}

export function taskFailureFromUnknown(
  error: unknown,
  fallbackCode: TaskErrorCode,
  fallbackMessage: string,
): TaskFailure {
  if (error instanceof TaskOperationError) {
    return {
      success: false,
      error,
    };
  }

  return taskFailure(
    fallbackCode,
    fallbackMessage,
    {
      cause: error,
    },
  );
}

export function isTaskOperationError(
  error: unknown,
): error is TaskOperationError {
  return error instanceof TaskOperationError;
}
