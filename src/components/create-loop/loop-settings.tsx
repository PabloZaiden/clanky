interface LoopSettingsProps {
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  autoAcceptPlan: boolean;
  onAutoAcceptPlanChange: (value: boolean) => void;
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
}

export function LoopSettings({
  planMode,
  onPlanModeChange,
  autoAcceptPlan,
  onAutoAcceptPlanChange,
  useWorktree,
  onUseWorktreeChange,
}: LoopSettingsProps) {
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
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Auto-accept plan
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
