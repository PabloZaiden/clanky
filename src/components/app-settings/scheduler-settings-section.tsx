const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function getTimezoneOptions(currentTimezone: string): string[] {
  const supportedValuesOf = (Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  }).supportedValuesOf;
  const timezones = supportedValuesOf ? supportedValuesOf("timeZone") : FALLBACK_TIMEZONES;
  return Array.from(new Set([currentTimezone, ...timezones])).filter(Boolean).sort();
}

export function SchedulerSettingsSection({
  timezone,
  loading,
  saving,
  error,
  onUpdate,
}: {
  timezone: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onUpdate: (timezone: string) => Promise<string | null>;
}) {
  const timezoneOptions = getTimezoneOptions(timezone);

  return (
    <div>
      <h3 className="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">
        Agents
      </h3>
      <div className="rounded-lg bg-gray-50 p-4 dark:bg-neutral-900">
        <label htmlFor="scheduler-timezone" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Timezone
        </label>
        <select
          id="scheduler-timezone"
          value={timezone}
          onChange={(event) => void onUpdate(event.target.value)}
          disabled={loading || saving}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
        >
          {timezoneOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {error && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}
