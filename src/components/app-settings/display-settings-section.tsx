/** Display Settings section: theme and markdown rendering preferences. */

import { useMarkdownPreference, useThemePreference } from "../../hooks";
import type { ThemePreference } from "../../types/preferences";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
];

export function DisplaySettingsSection() {
  const { enabled: markdownEnabled, toggle: toggleMarkdown, saving: savingMarkdown } = useMarkdownPreference();
  const { theme, setTheme, saving: savingTheme, loading: loadingTheme } = useThemePreference();

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-4">
        Display Settings
      </h3>
      <div className="space-y-3 p-4 rounded-lg bg-gray-50 dark:bg-neutral-900">
        <div>
          <label htmlFor="theme-preference" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Theme
          </label>
          <select
            id="theme-preference"
            value={theme}
            onChange={(event) => void setTheme(event.target.value as ThemePreference)}
            disabled={loadingTheme || savingTheme}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={markdownEnabled}
            onChange={() => toggleMarkdown()}
            disabled={savingMarkdown}
            className="h-4 w-4 rounded border-gray-300 text-gray-700 focus:ring-gray-500 disabled:opacity-50"
          />
          <div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Render Markdown
            </span>
          </div>
        </label>
      </div>
    </div>
  );
}
