/**
 * Resolves task ownership and the current dedicated harness before control.
 */

import type { TaskCtx } from "./context";
import { backendManager } from "../backend-manager";
import { harnessActivityService } from "../harness-activity-service";
import { HarnessError } from "../../backends/harness-errors";
import { TaskOperationError } from "./task-errors";
import { getHarnessWorkspaceSafety } from "../harness-workspace-safety";
import { mergeHarnessProjection } from "../../persistence/harness-state";
import { recoverOwnedNativeEngineImpl } from "./task-engine-recovery";

async function resolveTaskHarness(ctx: TaskCtx, taskId: string) {
  const task = await ctx.getTask(taskId);
  if (!task) throw new HarnessError("harness_session_not_found", "The task is unavailable.");
  return { task, backend: backendManager.getInitializedContextBackend(taskId) };
}

export async function getTaskHarnessActivity(ctx: TaskCtx, taskId: string) {
  const { task, backend } = await resolveTaskHarness(ctx, taskId);
  if (task.state.session?.binding?.adapter === "acp" || backend?.harness.capabilities.activity === "unavailable") return { observation: "unavailable" as const, reason: "unsupported" as const };
  if (!backend?.isConnected()) return { observation: "unavailable" as const, reason: "disconnected" as const };
  const binding = task.state.session?.binding;
  if (!binding) throw new HarnessError("harness_session_not_owned", "Activity requires an owned conversation.");
  return harnessActivityService.getActivity({ kind: "task", id: taskId }, binding, backend);
}

export async function stopTaskHarnessActivity(ctx: TaskCtx, taskId: string, activityId: string) {
  const { task, backend } = await resolveTaskHarness(ctx, taskId);
  if (!backend?.isConnected()) throw new HarnessError("harness_transport_closed", "Reconnect before stopping native activity.");
  const binding = task.state.session?.binding;
  if (!binding) throw new HarnessError("harness_session_not_owned", "Activity control requires an owned conversation.");
  return harnessActivityService.stopActivity({ kind: "task", id: taskId }, binding, backend, activityId);
}

export async function assertTaskHarnessWorkspaceSafe(
  ctx: TaskCtx,
  taskId: string,
  options: { requireFinalCommit?: boolean } = {},
): Promise<void> {
  await ctx.engines.get(taskId)?.waitForCompletionSettlement();
  let { task, backend } = await resolveTaskHarness(ctx, taskId);
  const nativeBinding = task.state.session?.binding;
  if (options.requireFinalCommit !== false && nativeBinding && nativeBinding.adapter !== "acp" && task.state.status === "completed" && task.state.harness?.gitOutcome?.status !== "succeeded") {
    const engine = ctx.engines.get(taskId) ?? await recoverOwnedNativeEngineImpl(ctx, taskId, "finalization");
    await engine.retryWorkspaceFinalization();
    ({ task, backend } = await resolveTaskHarness(ctx, taskId));
  }
  const binding = task.state.session?.binding;
  if (binding === undefined || binding?.adapter === "acp") return;
  if (binding === null || task.state.harness?.integrity === "invalid") {
    throw new TaskOperationError("task_background_work_unsettled", "Native workspace ownership is unavailable.");
  }
  if (options.requireFinalCommit !== false && task.state.harness?.gitOutcome?.status === "failed") {
    throw new TaskOperationError("task_final_git_failed", "The final task commit failed.");
  }
  if (!backend?.isConnected()) {
    if (task.state.harness?.cleanup?.status === "settled" && task.state.harness.gitSafety?.status === "safe") {
      if (options.requireFinalCommit !== false && task.state.status === "completed" && task.state.harness.gitOutcome?.status !== "succeeded") {
        throw new TaskOperationError("task_final_git_pending", "Native task Git finalization is still pending.");
      }
      return;
    }
    throw new TaskOperationError("task_background_work_unsettled", "Reconnect to confirm native workspace settlement.");
  }
  const context = { kind: "task" as const, id: taskId };
  const cleanup = await harnessActivityService.settle(context, binding, backend);
  const gitSafety = getHarnessWorkspaceSafety(await harnessActivityService.getActivity(context, binding, backend));
  mergeHarnessProjection(context, binding, { gitSafety });
  if (cleanup.status !== "settled" || gitSafety.status !== "safe") {
    throw new TaskOperationError("task_background_work_unsettled", "Native workspace settlement is unresolved.");
  }
  if (options.requireFinalCommit !== false && task.state.status === "completed" && task.state.harness?.gitOutcome?.status !== "succeeded") {
    throw new TaskOperationError("task_final_git_pending", "Native task Git finalization is still pending.");
  }
}
