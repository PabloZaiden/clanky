import { SettingsError, SettingsSelect } from "./settings-row-controls";

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

export function SchedulerTimezoneRowContent({
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
  return (
    <div className="space-y-2">
      <SettingsSelect
        id="scheduler-timezone"
        aria-label="Agent scheduler timezone"
        value={timezone}
        onChange={(event) => void onUpdate(event.currentTarget.value)}
        disabled={loading || saving}
      >
        {getTimezoneOptions(timezone).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SettingsSelect>
      {error ? <SettingsError>{error}</SettingsError> : null}
    </div>
  );
}
