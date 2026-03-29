/** Developer Settings section: log level preference. */

import { useLogLevelPreference } from "../../hooks";
import type { LogLevelName } from "../../lib/logger";

export function DeveloperSettingsSection() {
  const { level: logLevel, availableLevels, setLevel: setLogLevel, saving: savingLogLevel, isFromEnv: logLevelFromEnv } = useLogLevelPreference();

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-4">
        Developer Settings
      </h3>
      <div className="space-y-3 p-4 rounded-lg bg-gray-50 dark:bg-neutral-900">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <label
              htmlFor="log-level"
              className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1"
            >
              Log Level
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Controls the verbosity of logging for both frontend and backend.
              Lower levels show more detailed information for debugging.
            </p>
            {logLevelFromEnv ? (
              <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-md px-3 py-2">
                Log level is controlled by the <code className="break-all rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-800">RALPHER_LOG_LEVEL</code> environment variable.
                Current level: <strong>{logLevel}</strong>
              </div>
            ) : (
              <select
                id="log-level"
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value as LogLevelName)}
                disabled={savingLogLevel}
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 bg-white px-3 py-2 dark:bg-neutral-800 text-sm text-gray-900 dark:text-gray-100 shadow-sm focus:border-gray-500 focus:ring-gray-500 disabled:opacity-50"
              >
                {availableLevels.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} - {option.description}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
