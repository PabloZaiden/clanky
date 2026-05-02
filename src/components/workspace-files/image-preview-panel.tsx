import { Button, RefreshIcon } from "../common";

interface WorkspaceImagePreviewPanelProps {
  filePath?: string;
  pendingFilePath?: string | null;
  imagePreviewUrl: string | null;
  loading: boolean;
  autoReloadedAt: string | null;
  onRefresh: () => Promise<boolean>;
}

export function WorkspaceImagePreviewPanel({
  filePath,
  pendingFilePath,
  imagePreviewUrl,
  loading,
  autoReloadedAt,
  onRefresh,
}: WorkspaceImagePreviewPanelProps) {
  const displayPath = pendingFilePath ?? filePath;
  const statusText = loading
    ? `Loading ${pendingFilePath ?? filePath ?? "image"}...`
    : autoReloadedAt
      ? `Auto-reloaded at ${new Date(autoReloadedAt).toLocaleTimeString()}`
      : null;

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {displayPath ?? "No image selected"}
          </h2>
          {statusText && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {statusText}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={!filePath || loading}
          icon={<RefreshIcon size="h-4 w-4" />}
          aria-label="Refresh image"
          title="Refresh image"
          className="w-9 px-0"
        >
          <span className="sr-only">Refresh image</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-gray-50 p-4 dark:bg-neutral-950">
        {loading && pendingFilePath ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-gray-500 dark:text-gray-400">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent dark:border-gray-500" />
            <div>
              <p className="font-medium text-gray-700 dark:text-gray-200">Loading selected image</p>
              <p className="mt-1 break-all">{pendingFilePath}</p>
            </div>
          </div>
        ) : imagePreviewUrl && filePath ? (
          <div className="flex min-h-full items-center justify-center">
            <img
              src={imagePreviewUrl}
              alt={filePath}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Select an image file from the explorer to preview it.
          </div>
        )}
      </div>
    </section>
  );
}
