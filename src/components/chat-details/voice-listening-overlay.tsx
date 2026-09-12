import { Button } from "../common";
import type { VoiceRecorderStatus } from "../../hooks";
import { VOICE_MAX_RECORDING_MS } from "../../hooks";
import { Modal } from "@pablozaiden/webapp/web";

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
  const title = listening
    ? "Listening"
    : transcribing
      ? "Transcribing…"
      : "Voice input failed";
  return (
    <Modal
      isOpen
      onClose={listening || transcribing ? onCancel : onDismissError}
      title={title}
      showCloseButton={false}
      closeOnOverlayClick={false}
      size="sm"
      className="w-full max-w-md"
      footer={(
        listening ? (
          <>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={onStop}>
              Stop
            </Button>
          </>
        ) : transcribing ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onDismissError}>
            Close
          </Button>
        )
      )}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        {listening ? (
          <>
            <div className="flex h-28 w-28 items-center justify-center rounded-full bg-red-100 text-5xl shadow-inner dark:bg-red-950/60" aria-hidden="true">
              <span className="animate-pulse">●</span>
            </div>
            <p className="font-mono text-sm text-gray-500 dark:text-gray-400">
              {formatElapsed(elapsedMs)} / {formatElapsed(VOICE_MAX_RECORDING_MS)}
            </p>
          </>
        ) : transcribing ? (
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300 border-t-gray-900 dark:border-gray-700 dark:border-t-white" aria-hidden="true" />
        ) : (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error ?? "The recording could not be transcribed."}
          </p>
        )}
      </div>
    </Modal>
  );
}
