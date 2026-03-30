import { DEFAULT_LOOP_CONFIG } from "../../types/loop";

interface AdvancedOptionsProps {
  showAdvanced: boolean;
  onToggle: () => void;
  maxIterations: string;
  onMaxIterationsChange: (value: string) => void;
  maxConsecutiveErrors: string;
  onMaxConsecutiveErrorsChange: (value: string) => void;
  activityTimeoutSeconds: string;
  onActivityTimeoutChange: (value: string) => void;
  clearPlanningFolder: boolean;
  onClearPlanningFolderChange: (value: boolean) => void;
}

export function AdvancedOptions({
  showAdvanced,
  onToggle,
  maxIterations,
  onMaxIterationsChange,
  maxConsecutiveErrors,
  onMaxConsecutiveErrorsChange,
  activityTimeoutSeconds,
  onActivityTimeoutChange,
  clearPlanningFolder,
  onClearPlanningFolderChange,
}: AdvancedOptionsProps) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className="text-sm text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
      >
        {showAdvanced ? "Hide" : "Show"} advanced options
      </button>

      {showAdvanced && (
        <div className="space-y-4 p-4 bg-gray-50 dark:bg-neutral-800 rounded-md">
          {/* Max iterations */}
          <div>
            <label
              htmlFor="maxIterations"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Max Iterations
            </label>
            <input
              type="number"
              id="maxIterations"
              value={maxIterations}
              onChange={(e) => onMaxIterationsChange(e.target.value)}
              min="1"
              placeholder="Unlimited"
              className="mt-1 block w-32 rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Leave empty for unlimited iterations
            </p>
          </div>

          {/* Max consecutive errors */}
          <div>
            <label
              htmlFor="maxConsecutiveErrors"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Max Consecutive Errors
            </label>
            <input
              type="number"
              id="maxConsecutiveErrors"
              value={maxConsecutiveErrors}
              onChange={(e) => onMaxConsecutiveErrorsChange(e.target.value)}
              min="0"
              placeholder="10"
              className="mt-1 block w-32 rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Failsafe exit after this many identical consecutive errors. 0 = unlimited. (default: 10)
            </p>
          </div>

          {/* Activity timeout */}
          <div>
            <label
              htmlFor="activityTimeoutSeconds"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Activity Timeout (seconds)
            </label>
            <input
              type="number"
              id="activityTimeoutSeconds"
              value={activityTimeoutSeconds}
              onChange={(e) => onActivityTimeoutChange(e.target.value)}
              min="60"
              placeholder={String(DEFAULT_LOOP_CONFIG.activityTimeoutSeconds)}
              className="mt-1 block w-32 rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Time without AI activity before treating as error and retrying. Minimum: 60 seconds. (default: {DEFAULT_LOOP_CONFIG.activityTimeoutSeconds})
            </p>
          </div>

          {/* Clear planning folder */}
          <div>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={clearPlanningFolder}
                onChange={(e) => onClearPlanningFolderChange(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-300"
              />
              <div className="flex-1">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Clear ./.planning folder
                </span>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Delete existing plan and status files before starting
                </p>
              </div>
            </label>
          </div>
        </div>
      )}
    </>
  );
}
