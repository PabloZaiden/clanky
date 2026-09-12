import { Button } from "../common";
import type { VoiceRecorderStatus } from "../../hooks";
import { VOICE_MAX_RECORDING_MS } from "../../hooks";

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceListeningOverlay({
  status,
  elapsedMs,
  error,
  onStop,
  onCancel,
  onDismissError,
}: {
  status: VoiceRecorderStatus;
  elapsedMs: number;
  error: string | null;
  onStop: () => void;
  onCancel: () => void;
  onDismissError: () => void;
}) {
  if (status === "idle") {
    return null;
  }

  const listening = status === "listening";
  const transcribing = status === "transcribing";
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-white/95 px-5 py-8 dark:bg-neutral-950/95"
      role="dialog"
      aria-modal="true"
      aria-label={listening ? "Listening" : transcribing ? "Transcribing recording" : "Voice input error"}
    >
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        {listening ? (
          <>
            <div className="flex h-28 w-28 items-center justify-center rounded-full bg-red-100 text-5xl shadow-inner dark:bg-red-950/60" aria-hidden="true">
              <span className="animate-pulse">●</span>
            </div>
            <div>
              <h2 className="text-3xl font-semibold text-gray-950 dark:text-white">Listening</h2>
              <p className="mt-2 font-mono text-sm text-gray-500 dark:text-gray-400">
                {formatElapsed(elapsedMs)} / {formatElapsed(VOICE_MAX_RECORDING_MS)}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2">
              <Button type="button" variant="danger" size="lg" onClick={onStop}>
                Stop
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </>
        ) : transcribing ? (
          <>
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-gray-900 dark:border-gray-700 dark:border-t-white" aria-hidden="true" />
            <div>
              <h2 className="text-2xl font-semibold text-gray-950 dark:text-white">Transcribing…</h2>
            </div>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-semibold text-gray-950 dark:text-white">Voice input failed</h2>
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error ?? "The recording could not be transcribed."}
            </p>
            <Button type="button" variant="secondary" onClick={onDismissError}>
              Close
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
