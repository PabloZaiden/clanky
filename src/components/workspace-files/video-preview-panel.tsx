import { useEffect, useState } from "react";
import { Button, RefreshIcon } from "../common";

interface WorkspaceVideoPreviewPanelProps {
  filePath?: string;
  pendingFilePath?: string | null;
  videoPreviewUrl: string | null;
  loading: boolean;
  autoReloadedAt: string | null;
  onRefresh: () => Promise<boolean>;
}

export function WorkspaceVideoPreviewPanel({
  filePath,
  pendingFilePath,
  videoPreviewUrl,
  loading,
  autoReloadedAt,
  onRefresh,
}: WorkspaceVideoPreviewPanelProps) {
  const [playbackError, setPlaybackError] = useState(false);
  const displayPath = pendingFilePath ?? filePath;
  useEffect(() => {
    setPlaybackError(false);
  }, [filePath, videoPreviewUrl]);

  const statusText = loading
    ? `Loading ${pendingFilePath ?? filePath ?? "video"}...`
    : autoReloadedAt
      ? `Auto-reloaded at ${new Date(autoReloadedAt).toLocaleTimeString()}`
      : null;

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {displayPath ?? "No video selected"}
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
          aria-label="Refresh video"
          title="Refresh video"
          className="w-9 px-0"
        >
          <span className="sr-only">Refresh video</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-gray-50 p-4 dark:bg-neutral-950">
        {loading && pendingFilePath ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-gray-500 dark:text-gray-400">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-400 border-t-transparent dark:border-gray-500" />
            <div>
              <p className="font-medium text-gray-700 dark:text-gray-200">Loading selected video</p>
              <p className="mt-1 break-all">{pendingFilePath}</p>
            </div>
          </div>
        ) : playbackError ? (
          <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-600 dark:text-gray-300">
            This video could not be played in the browser. Use Download selected file to open it with another media player.
          </div>
        ) : videoPreviewUrl && filePath ? (
          <div className="flex h-full min-h-0 items-center justify-center">
            <video
              key={videoPreviewUrl}
              src={videoPreviewUrl}
              controls
              playsInline
              preload="metadata"
              aria-label={`Video preview: ${filePath}`}
              onError={() => setPlaybackError(true)}
              className="h-full w-full bg-black object-contain"
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            Select a video file from the explorer to preview it.
          </div>
        )}
      </div>
    </section>
  );
}
