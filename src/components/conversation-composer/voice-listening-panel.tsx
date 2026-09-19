import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button, CloseIcon, RefreshIcon } from "../common";
import type { VoiceRecorderStatus } from "../../hooks/useVoiceRecorder";
import { VOICE_MAX_RECORDING_MS } from "../../hooks/useVoiceRecorder";

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function VoiceActionButton({
  label,
  variant,
  onClick,
  children,
}: {
  label: string;
  variant: "ghost" | "primary";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      className="!h-8 !w-8 !p-0"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span aria-hidden="true">{children}</span>
    </Button>
  );
}

export function VoiceListeningPanel({
  status,
  elapsedMs,
  error,
  onStop,
  onCancel,
  onRetry,
  onDismissError,
}: {
  status: VoiceRecorderStatus;
  elapsedMs: number;
  error: string | null;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => Promise<void>;
  onDismissError: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (status !== "idle") {
      panelRef.current?.focus();
    }
  }, [status]);

  if (status === "idle") {
    return null;
  }

  const listening = status === "listening";
  const requesting = status === "requesting";
  const transcribing = status === "transcribing";
  const pending = requesting || transcribing;
  let title = "Voice input failed";
  if (listening) {
    title = "Listening";
  } else if (requesting) {
    title = "Requesting microphone…";
  } else if (transcribing) {
    title = "Transcribing…";
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    if (listening || pending) {
      onCancel();
    } else {
      onDismissError();
    }
  }

  return (
    <section
      ref={panelRef}
      aria-label="Voice input"
      aria-busy={pending || undefined}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="border-t border-[var(--wapp-border-soft)] bg-[var(--wapp-surface)] px-3 py-2.5 text-[var(--wapp-text)] shadow-[var(--wapp-shadow)] sm:px-4"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3">
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
            listening
              ? "bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-300"
              : status === "error"
                ? "bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-300"
                : "bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300"
          }`}
          aria-hidden="true"
        >
          {listening ? (
            <span className="animate-pulse text-base leading-none">●</span>
          ) : pending ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <span className="text-sm font-semibold leading-none">!</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p aria-live="polite" className="text-sm font-medium">
            {title}
          </p>
          {listening ? (
            <p className="font-mono text-xs text-[var(--wapp-muted)]">
              {formatElapsed(elapsedMs)} / {formatElapsed(VOICE_MAX_RECORDING_MS)}
            </p>
          ) : status === "error" ? (
            <p role="alert" className="break-words text-xs text-red-600 dark:text-red-400">
              {error ?? "The recording could not be transcribed."}
            </p>
          ) : null}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {listening ? (
            <>
              <VoiceActionButton
                label="Cancel voice input"
                variant="ghost"
                onClick={onCancel}
              >
                <CloseIcon />
              </VoiceActionButton>
              <VoiceActionButton
                label="Stop recording"
                variant="primary"
                onClick={onStop}
              >
                <span className="text-lg leading-none">↑</span>
              </VoiceActionButton>
            </>
          ) : pending ? (
            <VoiceActionButton
              label="Cancel voice input"
              variant="ghost"
              onClick={onCancel}
            >
              <CloseIcon />
            </VoiceActionButton>
          ) : (
            <>
              <VoiceActionButton
                label="Dismiss voice input error"
                variant="ghost"
                onClick={onDismissError}
              >
                <CloseIcon />
              </VoiceActionButton>
              <VoiceActionButton
                label="Retry microphone"
                variant="primary"
                onClick={() => void onRetry()}
              >
                <RefreshIcon />
              </VoiceActionButton>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
