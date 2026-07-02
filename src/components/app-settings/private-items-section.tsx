import type { PrivateItemsPreference } from "../../hooks/usePrivateItemsPreference";

export function PrivateItemsSection({
  preference,
}: {
  preference: PrivateItemsPreference;
}) {
  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={preference.showPrivateItems}
          onChange={(event) => preference.setShowPrivateItems(event.currentTarget.checked)}
          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-800 dark:focus:ring-gray-600"
        />
        <span>
          <span className="block font-medium text-gray-900 dark:text-gray-100">
            Show private items
          </span>
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            Stored only in this browser. When disabled, private items stay visible but are blurred, excluded from sidebar search, and cannot be opened from lists.
          </span>
        </span>
      </label>
    </div>
  );
}
