import { useCallback, useEffect, useRef, useState } from "react";
import { Button, RefreshIcon } from "../common";

const CREDENTIAL_RENEWAL_LEAD_MS = 10_000;

interface WorkspaceVideoPreviewPanelProps {
  filePath?: string;
  pendingFilePath?: string | null;
  videoPreviewUrl: string | null;
  videoPreviewUrlExpiresAt: number | null;
  loading: boolean;
  autoReloadedAt: string | null;
  onRefresh: () => Promise<boolean>;
  onRenewVideoPreviewUrl: () => Promise<boolean>;
}

export function WorkspaceVideoPreviewPanel({
  filePath,
  pendingFilePath,
  videoPreviewUrl,
  videoPreviewUrlExpiresAt,
  loading,
  autoReloadedAt,
  onRefresh,
  onRenewVideoPreviewUrl,
}: WorkspaceVideoPreviewPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeVideoUrlRef = useRef<string | null>(null);
  const activeFilePathRef = useRef<string | undefined>(filePath);
  const playbackIntentRef = useRef(false);
  const renewalPromiseRef = useRef<Promise<boolean> | null>(null);
  const onRenewVideoPreviewUrlRef = useRef(onRenewVideoPreviewUrl);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const displayPath = pendingFilePath ?? filePath;
  onRenewVideoPreviewUrlRef.current = onRenewVideoPreviewUrl;

  const renewVideoPreviewUrl = useCallback(async (): Promise<boolean> => {
    if (renewalPromiseRef.current) {
      return await renewalPromiseRef.current;
    }

    setRenewing(true);
    const renewalPromise = (async () => {
      try {
        const renewed = await onRenewVideoPreviewUrlRef.current();
        if (renewed) {
          setPlaybackError(null);
        } else {
          setPlaybackError(
            "The secure video stream could not be renewed. Refresh the video or download the file.",
          );
        }
        return renewed;
      } catch (error) {
        setPlaybackError(
          `The secure video stream could not be renewed: ${String(error)}. Refresh the video or download the file.`,
        );
        return false;
      } finally {
        renewalPromiseRef.current = null;
        setRenewing(false);
      }
    })();
    renewalPromiseRef.current = renewalPromise;
    return await renewalPromise;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!videoPreviewUrl) {
      activeVideoUrlRef.current = null;
      activeFilePathRef.current = filePath;
      return;
    }
    if (!video) {
      return;
    }

    const previousUrl = activeVideoUrlRef.current;
    const preservePlayback = previousUrl !== null
      && activeFilePathRef.current === filePath
      && video.currentSrc === new URL(previousUrl, document.baseURI).href;
    const playbackPosition = preservePlayback && Number.isFinite(video.currentTime)
      ? video.currentTime
      : null;
    const wasPlaying = preservePlayback && playbackIntentRef.current;
    const restorePlayback = () => {
      if (playbackPosition !== null) {
        const lastSeekableTime = Number.isFinite(video.duration)
          ? Math.max(0, video.duration - 0.05)
          : playbackPosition;
        video.currentTime = Math.min(playbackPosition, lastSeekableTime);
        if (wasPlaying) {
          void video.play().catch((error: unknown) => {
            setPlaybackError(`The video stream was renewed but playback could not resume: ${String(error)}.`);
          });
        }
      }
      setPlaybackError(null);
    };

    video.addEventListener("loadedmetadata", restorePlayback, { once: true });
    activeVideoUrlRef.current = videoPreviewUrl;
    activeFilePathRef.current = filePath;
    video.src = videoPreviewUrl;
    video.load();
    return () => {
      video.removeEventListener("loadedmetadata", restorePlayback);
    };
  }, [filePath, videoPreviewUrl]);

  useEffect(() => {
    if (!videoPreviewUrl || videoPreviewUrlExpiresAt === null) {
      return;
    }
    const renewInMs = Math.max(
      0,
      videoPreviewUrlExpiresAt - Date.now() - CREDENTIAL_RENEWAL_LEAD_MS,
    );
    const timer = window.setTimeout(() => {
      void renewVideoPreviewUrl();
    }, renewInMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [renewVideoPreviewUrl, videoPreviewUrl, videoPreviewUrlExpiresAt]);

  useEffect(() => {
    if (!videoPreviewUrl || videoPreviewUrlExpiresAt === null) {
      return;
    }
    const refreshIfExpiring = () => {
      if (
        document.visibilityState === "visible"
        && Date.now() >= videoPreviewUrlExpiresAt - CREDENTIAL_RENEWAL_LEAD_MS
      ) {
        void renewVideoPreviewUrl();
      }
    };
    document.addEventListener("visibilitychange", refreshIfExpiring);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfExpiring);
    };
  }, [renewVideoPreviewUrl, videoPreviewUrl, videoPreviewUrlExpiresAt]);

  const handlePlaybackError = useCallback(() => {
    if (
      videoPreviewUrlExpiresAt !== null
      && Date.now() >= videoPreviewUrlExpiresAt - CREDENTIAL_RENEWAL_LEAD_MS
    ) {
      void renewVideoPreviewUrl();
      return;
    }
    setPlaybackError(
      "This video could not be played in the browser. Use Download selected file to open it with another media player.",
    );
  }, [renewVideoPreviewUrl, videoPreviewUrlExpiresAt]);

  const statusText = loading
    ? `Loading ${pendingFilePath ?? filePath ?? "video"}...`
    : renewing
      ? "Refreshing secure video stream..."
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
            {playbackError}
          </div>
        ) : videoPreviewUrl && filePath ? (
          <div className="flex h-full min-h-0 items-center justify-center">
            <video
              ref={videoRef}
              controls
              playsInline
              preload="metadata"
              aria-label={`Video preview: ${filePath}`}
              onError={handlePlaybackError}
              onPlay={() => {
                playbackIntentRef.current = true;
              }}
              onPause={(event) => {
                if (!event.currentTarget.error && !event.currentTarget.ended) {
                  playbackIntentRef.current = false;
                }
              }}
              onEnded={() => {
                playbackIntentRef.current = false;
              }}
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
