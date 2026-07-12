import { useEffect, useState } from "react";
import { POST_APPROVAL_FULLY_AUTONOMOUS_EDITABLE_STATUSES, type Task } from "../../types/task";
import type { UpdateTaskRequest } from "../../types";
import type { EntityLabels } from "../../utils";
import { formatDateTime, formatModelDisplay } from "./types";
import { taskDetailsTabContentFullWidthClassName, taskDetailsTabScrollContainerClassName } from "./tab-layout";

interface InfoTabProps {
  task: Task;
  labels: EntityLabels;
  onOpenTaskFiles: () => void;
  sshConnecting: boolean;
  onConnectViaSsh: () => void;
  planningSettingsSubmitting: boolean;
  onUpdatePlanningSettings: (
    request: Pick<UpdateTaskRequest, "autoAcceptPlan" | "fullyAutonomous">,
  ) => Promise<boolean>;
}

export function InfoTab({
  task,
  labels,
  onOpenTaskFiles,
  sshConnecting,
  onConnectViaSsh,
  planningSettingsSubmitting,
  onUpdatePlanningSettings,
}: InfoTabProps) {
  const { config, state } = task;
  const canEditAutoAcceptPlan = state.status === "planning" && config.planMode;
  const canEditFullyAutonomous = config.planMode && (
    canEditAutoAcceptPlan
    || (state.planMode?.active === false && POST_APPROVAL_FULLY_AUTONOMOUS_EDITABLE_STATUSES.has(state.status))
  );
  const [autoAcceptPlan, setAutoAcceptPlan] = useState(config.autoAcceptPlan === true);
  const [fullyAutonomous, setFullyAutonomous] = useState(config.fullyAutonomous === true);

  useEffect(() => {
    setAutoAcceptPlan(config.autoAcceptPlan === true);
    setFullyAutonomous(config.fullyAutonomous === true);
  }, [config.autoAcceptPlan, config.fullyAutonomous]);

  async function updatePlanningSettings(
    request: Pick<UpdateTaskRequest, "autoAcceptPlan" | "fullyAutonomous">,
  ): Promise<void> {
    const nextAutoAcceptPlan = request.autoAcceptPlan ?? autoAcceptPlan;
    const nextFullyAutonomous = request.fullyAutonomous ?? fullyAutonomous;
    setAutoAcceptPlan(nextAutoAcceptPlan);
    setFullyAutonomous(nextFullyAutonomous);
    const success = await onUpdatePlanningSettings(request);
    if (!success) {
      setAutoAcceptPlan(config.autoAcceptPlan === true);
      setFullyAutonomous(config.fullyAutonomous === true);
    }
  }

  function handleAutoAcceptPlanChange(checked: boolean): void {
    void updatePlanningSettings({ autoAcceptPlan: checked });
  }

  function handleFullyAutonomousChange(checked: boolean): void {
    void updatePlanningSettings({ fullyAutonomous: checked });
  }

  return (
    <div className={taskDetailsTabScrollContainerClassName}>
      <div className={`${taskDetailsTabContentFullWidthClassName} space-y-4`}>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{labels.capitalized} Information</h3>
        <div>
          <h4 className="mb-2 text-sm font-medium text-gray-500 dark:text-gray-400">Original Task Prompt</h4>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-gray-50 p-4 font-mono text-sm text-gray-900 [overflow-wrap:anywhere] dark:bg-neutral-900 dark:text-gray-100">
            {config.prompt || "No prompt specified."}
          </pre>
        </div>
        {state.pendingPrompt && (
          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-500 dark:text-gray-400">Pending Prompt</h4>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              This message will be injected on the next run.
            </p>
            <pre className="whitespace-pre-wrap break-words rounded-md bg-yellow-50 p-4 font-mono text-sm text-gray-900 [overflow-wrap:anywhere] dark:bg-yellow-950/30 dark:text-gray-100">
              {state.pendingPrompt}
            </pre>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Statistics */}
          <div className="space-y-2">
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Iteration: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {state.currentIteration}{config.maxIterations ? ` / ${config.maxIterations}` : ""}
              </span>
            </div>
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Started: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{formatDateTime(state.startedAt)}</span>
            </div>
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Last Activity: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{formatDateTime(state.lastActivityAt)}</span>
            </div>
            {state.completedAt && (
              <div className="text-sm">
                <span className="text-gray-500 dark:text-gray-400">Completed: </span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{formatDateTime(state.completedAt)}</span>
              </div>
            )}
          </div>

          {/* Git and Model info */}
          <div className="space-y-2">
            {config.issueNumber !== undefined && (
              <div className="text-sm">
                <span className="text-gray-500 dark:text-gray-400">GitHub Issue: </span>
                <span className="font-medium text-gray-900 dark:text-gray-100">#{config.issueNumber}</span>
              </div>
            )}
            {state.git && (
              <>
                <div className="text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Branch: </span>
                  <span className="font-mono font-medium text-gray-900 dark:text-gray-100 break-all">{state.git.originalBranch}</span>
                  <span className="text-gray-400 dark:text-gray-500"> → </span>
                  <span className="font-mono font-medium text-gray-900 dark:text-gray-100 break-all">{state.git.workingBranch}</span>
                </div>
                <div className="text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Commits: </span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{state.git.commits.length}</span>
                </div>
                {state.git.worktreePath && (
                  <div className="text-sm">
                    <span className="text-gray-500 dark:text-gray-400">Worktree: </span>
                    <span className="font-mono font-medium text-gray-900 dark:text-gray-100 break-all">{state.git.worktreePath}</span>
                  </div>
                )}
              </>
            )}
            <div className="text-sm">
              <span className="text-gray-500 dark:text-gray-400">Model: </span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {formatModelDisplay(config.model)}
              </span>
              {state.pendingModel && (
                <span className="ml-1 text-yellow-600 dark:text-yellow-400">
                  → {formatModelDisplay(state.pendingModel)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
          {(canEditAutoAcceptPlan || canEditFullyAutonomous) && (
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Plan automation</div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {canEditAutoAcceptPlan
                      ? "Update how this active planning task proceeds after the plan is ready."
                      : "The plan is already accepted. You can still decide whether the remaining execution should continue into automatic push and PR handling."}
                  </div>
                </div>
                {planningSettingsSubmitting && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">Updating...</span>
                )}
              </div>
              <div className="mt-3 space-y-3">
                {canEditAutoAcceptPlan && (
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={autoAcceptPlan}
                      onChange={(e) => handleAutoAcceptPlanChange(e.target.checked)}
                      disabled={planningSettingsSubmitting}
                      className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
                    />
                    <div className="flex-1">
                      <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Auto-accept plan
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        Skip manual plan review and continue as soon as the plan is ready.
                      </span>
                    </div>
                  </label>
                )}
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={fullyAutonomous}
                    onChange={(e) => handleFullyAutonomousChange(e.target.checked)}
                    disabled={planningSettingsSubmitting || !canEditFullyAutonomous}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
                  />
                  <div className="flex-1">
                    <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Fully autonomous task
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {canEditAutoAcceptPlan
                        ? "After the plan is accepted, keep going automatically: execute, push, and start the automatic PR flow."
                        : "Apply automatic push and PR handling to the rest of this already-approved plan execution."}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          <button
            onClick={onOpenTaskFiles}
            className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
              <span className="text-gray-700 dark:text-gray-300 text-sm">{"</>"}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Open code explorer</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Browse this task&apos;s files and open a task-linked terminal
              </div>
            </div>
            <span className="text-gray-400 dark:text-gray-500">→</span>
          </button>

          <button
            onClick={onConnectViaSsh}
            disabled={sshConnecting}
            className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
              <span className="text-gray-700 dark:text-gray-300 text-sm">⌁</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {sshConnecting ? "Connecting..." : "Connect via ssh"}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Open or reconnect to this task&apos;s persistent SSH session
              </div>
            </div>
            <span className="text-gray-400 dark:text-gray-500">→</span>
          </button>

        </div>
      </div>
    </div>
  );
}
