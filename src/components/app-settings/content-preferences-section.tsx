import type {
  UseFileExplorerFullTreePreferenceResult,
  UseMarkdownPreferenceResult,
} from "../../hooks";

function PreferenceToggle({
  id,
  title,
  description,
  enabled,
  loading,
  saving,
  error,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  return (
    <label htmlFor={id} className="flex items-start justify-between gap-4 rounded-lg bg-gray-50 p-4 text-sm dark:bg-neutral-900">
      <span>
        <span className="block font-medium text-gray-900 dark:text-gray-100">{title}</span>
        <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{description}</span>
        {error && (
          <span className="mt-2 block text-xs text-red-600 dark:text-red-400">{error}</span>
        )}
      </span>
      <input
        id={id}
        type="checkbox"
        checked={enabled}
        onChange={(event) => void onChange(event.currentTarget.checked)}
        disabled={loading || saving}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-300 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-800 dark:focus:ring-gray-600"
      />
    </label>
  );
}

export function ContentPreferencesSection({
  markdown,
  fullTree,
}: {
  markdown: UseMarkdownPreferenceResult;
  fullTree: UseFileExplorerFullTreePreferenceResult;
}) {
  return (
    <div>
      <h3 className="mb-4 text-sm font-medium text-gray-900 dark:text-gray-100">
        Content
      </h3>
      <div className="space-y-3">
        <PreferenceToggle
          id="markdown-rendering"
          title="Render markdown"
          description="Show task, chat and agent markdown as rich content instead of plain text."
          enabled={markdown.enabled}
          loading={markdown.loading}
          saving={markdown.saving}
          error={markdown.error}
          onChange={markdown.setEnabled}
        />
        <PreferenceToggle
          id="file-explorer-full-tree"
          title="Load full file tree"
          description="Load the complete workspace file tree up front instead of expanding directories lazily."
          enabled={fullTree.enabled}
          loading={fullTree.loading}
          saving={fullTree.saving}
          error={fullTree.error}
          onChange={fullTree.setEnabled}
        />
      </div>
    </div>
  );
}
