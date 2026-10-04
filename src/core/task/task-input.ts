/**
 * Resolves task ownership before native pending-input admission or recovery.
 */

import type { TaskCtx } from "./context";
import { HarnessError } from "../../backends/harness-errors";
import { TaskOperationError } from "./task-errors";
import { recoverOwnedNativeEngineImpl } from "./task-engine-recovery";

export async function steerTaskPendingInput(ctx: TaskCtx, taskId: string, inputId: string) {
  const task = await ctx.getTask(taskId);
  if (!task) throw new HarnessError("harness_session_not_found", "The task is unavailable.");
  const engine = ctx.engines.get(taskId);
  if (!engine) throw new TaskOperationError("task_not_running", "The native task is not running.");
  const admission = await engine.steerPendingInput(inputId);
  const latest = await ctx.getTask(taskId);
  if (!latest) throw new HarnessError("harness_session_not_found", "The task was removed during input admission.");
  return { task: latest, admission };
}

export async function reconcileTaskPendingInput(ctx: TaskCtx, taskId: string, inputId: string) {
  const task = await ctx.getTask(taskId);
  if (!task) throw new HarnessError("harness_session_not_found", "The task is unavailable.");
  if (!task.state.harness?.inputs?.some((entry) => entry.admission.inputId === inputId)) {
    throw new HarnessError("harness_input_not_found", "Native task input admission is unavailable.");
  }
  const engine = ctx.engines.get(taskId) ?? await recoverOwnedNativeEngineImpl(ctx, taskId, "input-recovery");
  const admission = await engine.reconcilePendingInput(inputId);
  const latest = await ctx.getTask(taskId);
  if (!latest) throw new HarnessError("harness_session_not_found", "The task was removed during input recovery.");
  return { task: latest, admission };
}
