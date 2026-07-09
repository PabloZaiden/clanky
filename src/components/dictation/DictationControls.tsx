import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "../common";
import { useDictation, type DictationLanguage, type DictationStatus } from "./use-dictation";

const LANGUAGE_STORAGE_KEY = "clanky.dictation.language";

interface DictationControlsProps {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

function getInitialLanguage(): DictationLanguage {
  if (typeof window === "undefined") {
    return "auto";
  }
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "english" || stored === "spanish" || stored === "auto" ? stored : "auto";
}

function getStatusLabel(status: DictationStatus): string {
  switch (status) {
    case "recording":
      return "Stop dictation";
    case "model-loading":
      return "Loading model";
    case "transcribing":
      return "Transcribing";
    case "unsupported":
      return "Dictation unavailable";
    default:
      return "Start dictation";
  }
}

function MusicNoteIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 18V6l10-2v12M9 18a2.5 2.5 0 11-2.5-2.5A2.5 2.5 0 019 18zm10-2a2.5 2.5 0 11-2.5-2.5A2.5 2.5 0 0119 16zM9 9l10-2"
      />
    </svg>
  );
}

function MicrophoneIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zm6-3a6 6 0 01-12 0m6 6v4m-3 0h6"
      />
    </svg>
  );
}

export function DictationControls({
  onTranscript,
  onError,
  disabled = false,
  compact = false,
  className = "",
}: DictationControlsProps) {
  const [language, setLanguage] = useState<DictationLanguage>(getInitialLanguage);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dictation = useDictation({ language, onTranscript, onError });
  const busy = dictation.status === "model-loading" || dictation.status === "transcribing";
  const recording = dictation.status === "recording";
  const buttonLabel = getStatusLabel(dictation.status);
  const compactButtonClassName = compact ? "min-w-[36px] px-2" : "";

  useEffect(() => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  const handleToggle = useCallback(() => {
    if (recording) {
      dictation.stop();
      return;
    }
    void dictation.start();
  }, [dictation, recording]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    void dictation.transcribeFile(file);
  }, [dictation]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
        className="hidden"
        onChange={handleFileChange}
      />
      <select
        value={language}
        onChange={(event) => setLanguage(event.target.value as DictationLanguage)}
        disabled={disabled || dictation.isBusy}
        className="min-h-[36px] rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
        aria-label="Dictation language"
      >
        <option value="auto">Auto ES/EN</option>
        <option value="spanish">Spanish</option>
        <option value="english">English</option>
      </select>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || !dictation.fileSupported || dictation.isBusy}
        onClick={() => fileInputRef.current?.click()}
        title={dictation.error ?? "Transcribe audio file"}
        aria-label="Transcribe audio file"
        className={compactButtonClassName}
      >
        <MusicNoteIcon />
      </Button>
      <Button
        type="button"
        size="sm"
        variant={recording ? "danger" : "secondary"}
        disabled={disabled || !dictation.microphoneSupported || busy}
        loading={busy}
        onClick={handleToggle}
        title={dictation.error ?? buttonLabel}
        aria-label={buttonLabel}
        className={compactButtonClassName}
      >
        {recording ? "Stop" : <MicrophoneIcon />}
      </Button>
      {!compact && dictation.error && (
        <span className="max-w-[18rem] text-xs text-red-600 dark:text-red-400">
          {dictation.error}
        </span>
      )}
    </div>
  );
}

export type { DictationLanguage };
