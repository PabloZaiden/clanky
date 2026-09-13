import { useCallback, useEffect, useRef, useState } from "react";
import { getVoiceAudioExtension } from "@/shared";
import { apiRequest } from "../lib/api-client";

export const VOICE_MAX_RECORDING_MS = 10 * 60 * 1_000;
const VOICE_RECORDING_MAX_BYTES = 20 * 1024 * 1024;

export type VoiceRecorderStatus =
  | "idle"
  | "requesting"
  | "listening"
  | "transcribing"
  | "error";

interface UseVoiceRecorderOptions {
  enabled: boolean;
  canStart?: () => boolean;
  onTranscript: (text: string) => void;
}

export interface UseVoiceRecorderResult {
  status: VoiceRecorderStatus;
  elapsedMs: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  dismissError: () => void;
}

function getRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function getErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = error.name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return getErrorName(error) === "AbortError";
}

function getRecordingErrorMessage(error: unknown): string {
  switch (getErrorName(error)) {
    case "NotAllowedError":
      return "Microphone access was blocked or is unavailable. Check your browser or device permissions, then try again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is temporarily unavailable. Try again.";
    case "SecurityError":
      return "Microphone access is blocked by browser or device settings. Check permissions and try again.";
    default:
      return String(error);
  }
}

export function useVoiceRecorder({
  enabled,
  canStart,
  onTranscript,
}: UseVoiceRecorderOptions): UseVoiceRecorderResult {
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderGenerationRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const startLockGenerationRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordedBytesRef = useRef(0);
  const discardRef = useRef(false);
  const recordingErrorRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  const canStartRef = useRef(canStart);

  const releaseStartLock = useCallback((generation: number): void => {
    if (startLockGenerationRef.current === generation) {
      startLockGenerationRef.current = null;
    }
  }, []);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    canStartRef.current = canStart;
  }, [canStart, onTranscript]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopStream = useCallback((): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearRecorder = useCallback((): void => {
    recorderRef.current = null;
    recorderGenerationRef.current = null;
    chunksRef.current = [];
    recordedBytesRef.current = 0;
    clearTimer();
    stopStream();
  }, [clearTimer, stopStream]);

  const fail = useCallback((message: string): void => {
    clearRecorder();
    if (!mountedRef.current) {
      return;
    }
    setError(message);
    setStatus("error");
  }, [clearRecorder]);

  const transcribeChunks = useCallback(async (
    chunks: Blob[],
    mimeType: string,
  ): Promise<void> => {
    const audio = new Blob(chunks, { type: mimeType || "audio/webm" });
    if (audio.size <= 0) {
      fail("No audio was captured.");
      return;
    }
    if (audio.size > VOICE_RECORDING_MAX_BYTES) {
      fail("The recording exceeds the 20 MB limit.");
      return;
    }

    const controller = new AbortController();
    requestControllerRef.current = controller;
    try {
      const form = new FormData();
      const filename = `clanky-voice-recording.${getVoiceAudioExtension(audio.type || mimeType)}`;
      form.append("file", new File([audio], filename, {
        type: audio.type || "audio/webm",
      }));
      const result = await apiRequest<{ text: string }>("/api/voice/transcribe", {
        method: "POST",
        body: form,
        signal: controller.signal,
        action: "Transcribe recording",
        fallbackMessage: "Failed to transcribe recording",
      });
      if (!mountedRef.current || controller.signal.aborted) {
        return;
      }
      const text = result.text.trim();
      if (!text) {
        fail("No speech was detected in the recording.");
        return;
      }
      onTranscriptRef.current(text);
      setError(null);
      setStatus("idle");
    } catch (transcriptionError) {
      if (controller.signal.aborted || isAbortError(transcriptionError)) {
        return;
      }
      fail(String(transcriptionError));
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [fail]);

  const finalizeRecording = useCallback((
    generation: number,
    recorder: MediaRecorder,
  ): void => {
    if (
      recorderRef.current !== recorder
      || recorderGenerationRef.current !== generation
    ) {
      return;
    }
    const chunks = chunksRef.current;
    const mimeType = recorder?.mimeType ?? "audio/webm";
    const discard = discardRef.current;
    const recordingError = recordingErrorRef.current;
    clearRecorder();
    discardRef.current = false;
    recordingErrorRef.current = null;
    if (recordingError) {
      if (mountedRef.current) {
        setElapsedMs(0);
        setError(recordingError);
        setStatus("error");
      }
      return;
    }
    if (discard || !mountedRef.current) {
      if (mountedRef.current) {
        setStatus("idle");
        setError(null);
      }
      return;
    }
    setStatus("transcribing");
    void transcribeChunks(chunks, mimeType);
  }, [clearRecorder, transcribeChunks]);

  const stop = useCallback((): void => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    setStatus("transcribing");
    recorder.stop();
  }, []);

  const cancel = useCallback((): void => {
    generationRef.current += 1;
    startLockGenerationRef.current = null;
    discardRef.current = true;
    recordingErrorRef.current = null;
    requestControllerRef.current?.abort();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    clearRecorder();
    if (mountedRef.current) {
      setStatus("idle");
      setError(null);
      setElapsedMs(0);
    }
  }, [clearRecorder]);

  const start = useCallback(async (): Promise<void> => {
    if (
      startLockGenerationRef.current !== null
      || (status !== "idle" && status !== "error")
    ) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startLockGenerationRef.current = generation;
    if (!enabled) {
      releaseStartLock(generation);
      setError("Voice transcription is not configured and validated.");
      setStatus("error");
      return;
    }
    if (canStartRef.current && !canStartRef.current()) {
      releaseStartLock(generation);
      setError("Clear the composer before starting voice input.");
      setStatus("error");
      return;
    }
    if (
      typeof navigator === "undefined"
      || !navigator.mediaDevices?.getUserMedia
      || typeof MediaRecorder === "undefined"
    ) {
      releaseStartLock(generation);
      setError("This browser does not support audio recording.");
      setStatus("error");
      return;
    }

    setError(null);
    setElapsedMs(0);
    setStatus("requesting");
    discardRef.current = false;
    recordingErrorRef.current = null;
    chunksRef.current = [];
    recordedBytesRef.current = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || generationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        releaseStartLock(generation);
        return;
      }
      streamRef.current = stream;
      const mimeType = getRecordingMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorderGenerationRef.current = generation;
      releaseStartLock(generation);
      startedAtRef.current = Date.now();
      recorder.ondataavailable = (event: BlobEvent) => {
        if (
          recorderRef.current !== recorder
          || recorderGenerationRef.current !== generation
        ) {
          return;
        }
        if (event.data.size > 0) {
          if (recordedBytesRef.current + event.data.size > VOICE_RECORDING_MAX_BYTES) {
            recordingErrorRef.current = "The recording exceeds the 20 MB limit.";
            discardRef.current = true;
            try {
              if (recorder.state !== "inactive") {
                recorder.stop();
              }
            } catch {
              fail("The recording exceeds the 20 MB limit.");
            }
            return;
          }
          recordedBytesRef.current += event.data.size;
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        if (
          recorderRef.current !== recorder
          || recorderGenerationRef.current !== generation
        ) {
          return;
        }
        const message = "The browser could not record audio.";
        recordingErrorRef.current = message;
        discardRef.current = true;
        try {
          if (recorder.state !== "inactive") {
            recorder.stop();
            return;
          }
        } catch {
          // Fall through to the explicit error state if stopping the recorder fails.
        }
        fail(message);
      };
      recorder.onstop = () => finalizeRecording(generation, recorder);
      recorder.start(1_000);
      setStatus("listening");
      timerRef.current = window.setInterval(() => {
        const nextElapsed = Date.now() - startedAtRef.current;
        setElapsedMs(Math.min(nextElapsed, VOICE_MAX_RECORDING_MS));
        if (nextElapsed >= VOICE_MAX_RECORDING_MS) {
          stop();
        }
      }, 1_000);
    } catch (recordingError) {
      if (generationRef.current !== generation || !mountedRef.current) {
        releaseStartLock(generation);
        return;
      }
      releaseStartLock(generation);
      clearRecorder();
      setError(getRecordingErrorMessage(recordingError));
      setStatus("error");
    }
  }, [clearRecorder, enabled, fail, finalizeRecording, releaseStartLock, status, stop]);

  const dismissError = useCallback((): void => {
    if (status === "error") {
      setStatus("idle");
      setError(null);
      setElapsedMs(0);
    }
  }, [status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      startLockGenerationRef.current = null;
      discardRef.current = true;
      recordingErrorRef.current = null;
      requestControllerRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      clearRecorder();
    };
  }, [clearRecorder]);

  return {
    status,
    elapsedMs,
    error,
    start,
    stop,
    cancel,
    dismissError,
  };
}
