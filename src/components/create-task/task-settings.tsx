interface TaskSettingsProps {
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  autoAcceptPlan: boolean;
  onAutoAcceptPlanChange: (value: boolean) => void;
  fullyAutonomous: boolean;
  onFullyAutonomousChange: (value: boolean) => void;
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
}

export function TaskSettings({
  planMode,
  onPlanModeChange,
  autoAcceptPlan,
  onAutoAcceptPlanChange,
  fullyAutonomous,
  onFullyAutonomousChange,
  useWorktree,
  onUseWorktreeChange,
}: TaskSettingsProps) {
  return (
    <>
      <div>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={planMode}
            onChange={(e) => onPlanModeChange(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
          />
          <div className="flex-1">
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Plan Mode
            </span>
          </div>
        </label>
      </div>

      {planMode && (
        <div className="ml-7">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={autoAcceptPlan}
              onChange={(e) => onAutoAcceptPlanChange(e.target.checked)}
              disabled={fullyAutonomous}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Auto-accept plan
              </span>
              {fullyAutonomous && (
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  Required for fully autonomous tasks.
                </span>
              )}
            </div>
          </label>
        </div>
      )}

      {planMode && (
        <div className="ml-7">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={fullyAutonomous}
              onChange={(e) => onFullyAutonomousChange(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Fully autonomous task
              </span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                After the plan is accepted, keep going automatically: execute, push, and start the automatic PR flow.
              </span>
            </div>
          </label>
        </div>
      )}

      <div>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => onUseWorktreeChange(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
          />
          <div className="flex-1">
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Use Worktree
            </span>
          </div>
        </label>
      </div>
    </>
  );
}
