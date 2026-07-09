import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { transcribeDictationAudio } from "./dictation-transcriber";

const MAX_RECORDING_MS = 3 * 60 * 1000;
const MAX_AUDIO_DURATION_SECONDS = MAX_RECORDING_MS / 1000;
const MAX_AUDIO_FILE_BYTES = 10 * 1024 * 1024;

export type DictationLanguage = "auto" | "english" | "spanish";
export type DictationStatus =
  | "unsupported"
  | "idle"
  | "recording"
  | "model-loading"
  | "transcribing"
  | "error";

interface UseDictationOptions {
  language?: DictationLanguage;
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
}

interface UseDictationResult {
  status: DictationStatus;
  error: string | null;
  supported: boolean;
  microphoneSupported: boolean;
  fileSupported: boolean;
  isBusy: boolean;
  start: () => Promise<void>;
  stop: () => void;
  transcribeFile: (file: File) => Promise<void>;
  resetError: () => void;
}

type WindowWithWebkitAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
};

let transcriptionQueue: Promise<void> = Promise.resolve();

function enqueueTranscription<T>(task: () => Promise<T>): Promise<T> {
  const queued = transcriptionQueue.then(task, task);
  transcriptionQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.AudioContext ?? (window as WindowWithWebkitAudioContext).webkitAudioContext ?? null;
}

function getOfflineAudioContextConstructor(): typeof OfflineAudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.OfflineAudioContext
    ?? (window as WindowWithWebkitAudioContext).webkitOfflineAudioContext
    ?? null;
}

function getFileUnsupportedReason(): string | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "Dictation is only available in a browser.";
  }
  if (!getAudioContextConstructor()) {
    return "This browser does not support audio decoding.";
  }
  if (!getOfflineAudioContextConstructor()) {
    return "This browser does not support audio resampling.";
  }
  return null;
}

function getMicrophoneUnsupportedReason(): string | null {
  const fileUnsupportedReason = getFileUnsupportedReason();
  if (fileUnsupportedReason) {
    return fileUnsupportedReason;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser does not support microphone capture.";
  }
  if (typeof MediaRecorder === "undefined") {
    return "This browser does not support audio recording.";
  }
  return null;
}

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    throw new Error("This browser does not support audio decoding.");
  }

  const context = new AudioContextConstructor();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
}

async function resampleToMono16k(audioBuffer: AudioBuffer): Promise<Float32Array> {
  const OfflineAudioContextConstructor = getOfflineAudioContextConstructor();
  if (!OfflineAudioContextConstructor) {
    throw new Error("This browser does not support audio resampling.");
  }
  if (audioBuffer.duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error("Audio must be 3 minutes or shorter.");
  }
  const targetSampleRate = 16000;
  const length = Math.ceil(audioBuffer.duration * targetSampleRate);
  const offlineContext = new OfflineAudioContextConstructor(1, length, targetSampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineContext.destination);
  source.start(0);
  const rendered = await offlineContext.startRendering();
  return rendered.getChannelData(0);
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function stopRecorder(recorder: MediaRecorder | null): void {
  if (!recorder || recorder.state === "inactive") {
    return;
  }
  recorder.stop();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDictation({
  language = "auto",
  onTranscript,
  onError,
}: UseDictationOptions): UseDictationResult {
  const fileUnsupportedReason = useMemo(() => getFileUnsupportedReason(), []);
  const microphoneUnsupportedReason = useMemo(() => getMicrophoneUnsupportedReason(), []);
  const fileSupported = fileUnsupportedReason === null;
  const microphoneSupported = microphoneUnsupportedReason === null;
  const supported = fileSupported || microphoneSupported;
  const [status, setStatus] = useState<DictationStatus>(supported ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(fileUnsupportedReason);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const activeTranscriptionRef = useRef(0);
  const languageRef = useRef<DictationLanguage>(language);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const clearRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const clearRecorderState = useCallback(() => {
    clearRecordingTimer();
    stopTracks(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, [clearRecordingTimer]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      activeTranscriptionRef.current += 1;
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        stopRecorder(recorder);
      }
      clearRecorderState();
    };
  }, [clearRecorderState]);

  const handleError = useCallback((message: string) => {
    if (!mountedRef.current) {
      return;
    }
    setError(message);
    setStatus("error");
    onErrorRef.current?.(message);
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob) => {
    const transcriptionId = activeTranscriptionRef.current + 1;
    activeTranscriptionRef.current = transcriptionId;
    try {
      if (mountedRef.current) {
        setStatus("model-loading");
      }
      const text = await enqueueTranscription(async () => {
        let audioBuffer: AudioBuffer | null = await decodeBlob(blob);
        const audio = await resampleToMono16k(audioBuffer);
        audioBuffer = null;
        if (!mountedRef.current || activeTranscriptionRef.current !== transcriptionId) {
          return "";
        }
        setStatus("transcribing");
        return await transcribeDictationAudio(audio, languageRef.current);
      });
      if (!mountedRef.current || activeTranscriptionRef.current !== transcriptionId) {
        return;
      }
      if (text.length > 0) {
        onTranscriptRef.current(text);
      }
      setStatus("idle");
      setError(null);
    } catch (transcribeError) {
      handleError(getErrorMessage(transcribeError));
    }
  }, [handleError]);

  const start = useCallback(async () => {
    if (!microphoneSupported) {
      handleError(microphoneUnsupportedReason ?? "Microphone dictation is not supported in this browser.");
      return;
    }
    if (status === "recording") {
      return;
    }

    try {
      setError(null);
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stopTracks(stream);
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        clearRecordingTimer();
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        clearRecorderState();
        if (!mountedRef.current || blob.size === 0) {
          return;
        }
        void transcribeBlob(blob);
      };
      recorder.start(1000);
      recordingTimerRef.current = setTimeout(() => {
        stopRecorder(recorderRef.current);
      }, MAX_RECORDING_MS);
      setStatus("recording");
    } catch (startError) {
      clearRecorderState();
      handleError(getErrorMessage(startError));
    }
  }, [clearRecorderState, clearRecordingTimer, handleError, microphoneSupported, microphoneUnsupportedReason, status, transcribeBlob]);

  const stop = useCallback(() => {
    stopRecorder(recorderRef.current);
  }, []);

  const transcribeFile = useCallback(async (file: File) => {
    if (!fileSupported) {
      handleError(fileUnsupportedReason ?? "Audio file transcription is not supported in this browser.");
      return;
    }
    if (file.size > MAX_AUDIO_FILE_BYTES) {
      handleError("Audio files must be 10MB or smaller.");
      return;
    }
    await transcribeBlob(file);
  }, [fileSupported, fileUnsupportedReason, handleError, transcribeBlob]);

  const resetError = useCallback(() => {
    setError(null);
    setStatus(supported ? "idle" : "unsupported");
  }, [supported]);

  return {
    status,
    error,
    supported,
    microphoneSupported,
    fileSupported,
    isBusy: status === "recording" || status === "model-loading" || status === "transcribing",
    start,
    stop,
    transcribeFile,
    resetError,
  };
}
