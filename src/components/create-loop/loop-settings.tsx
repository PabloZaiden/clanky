interface LoopSettingsProps {
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  planModeAutoReply: boolean;
  onPlanModeAutoReplyChange: (value: boolean) => void;
  autoAcceptPlan: boolean;
  onAutoAcceptPlanChange: (value: boolean) => void;
  useWorktree: boolean;
  onUseWorktreeChange: (value: boolean) => void;
}

export function LoopSettings({
  planMode,
  onPlanModeChange,
  planModeAutoReply,
  onPlanModeAutoReplyChange,
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
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 sm:hidden">
              Review AI plan before execution
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 hidden sm:block">
              Create and review a plan before starting the loop. The AI will generate a plan based on your prompt, and you can provide feedback before execution begins.
            </p>
          </div>
        </label>
      </div>

      {planMode && (
        <div className="ml-7">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={planModeAutoReply}
              onChange={(e) => onPlanModeAutoReplyChange(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
            />
            <div className="flex-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Auto-reply plan questions
              </span>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Enabled by default. Turn this off to answer plan-mode questions yourself below the execution log.
              </p>
            </div>
          </label>
        </div>
      )}

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
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Disabled by default. Turn this on to skip manual plan review and start execution as soon as the plan is ready.
              </p>
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
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Run in a dedicated Ralph worktree. Turn this off to use the main checkout with a dedicated Ralph branch.
            </p>
          </div>
        </label>
      </div>
    </>
  );
}
