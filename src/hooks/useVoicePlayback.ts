import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import type { VoiceSpeechMode } from "@/shared";

function createSilentAudioUrl(): string {
  const sampleRate = 8_000;
  const sampleCount = sampleRate / 10;
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
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

function getPlaybackErrorMessage(error: unknown): string {
  if (getErrorName(error) === "NotAllowedError") {
    return "The browser blocked audio playback. Tap Play to try again.";
  }
  return "The generated audio could not be played. Tap Play to try again.";
}

export interface VoicePlaybackRecovery {
  key: string;
  mode: VoiceSpeechMode;
  message: string;
}

export interface UseVoicePlaybackResult {
  playingKey: string | null;
  status: "idle" | "generating" | "playing";
  playbackRecovery: VoicePlaybackRecovery | null;
  play: (key: string, text: string, mode: VoiceSpeechMode) => Promise<void>;
  retryPlayback: () => Promise<void>;
  stop: () => void;
}

export function useVoicePlayback(): UseVoicePlaybackResult {
  const toast = useToast();
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "generating" | "playing">("idle");
  const [playbackRecovery, setPlaybackRecovery] = useState<VoicePlaybackRecovery | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const unlockAudioUrlRef = useRef<string | null>(null);
  const primingGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const unlockAudio = useCallback((): void => {
    // Prime the same media element that will receive the TTS response. iOS
    // may reject a newly created element after the click activation expires.
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      audio.setAttribute("playsinline", "");
      audioRef.current = audio;
    }
    const url = unlockAudioUrlRef.current ?? createSilentAudioUrl();
    unlockAudioUrlRef.current ??= url;
    if (audio.getAttribute("src") !== url) {
      audio.src = url;
      audio.load();
    }
    audio.pause();
    audio.currentTime = 0;
    const primingGeneration = primingGenerationRef.current + 1;
    primingGenerationRef.current = primingGeneration;
    void audio.play().then(
      () => {
        if (
          primingGenerationRef.current === primingGeneration
          && audioRef.current === audio
        ) {
          audio.pause();
          audio.currentTime = 0;
        }
      },
      () => {
        // The real playback attempt below reports a user-facing error if needed.
      },
    );
  }, []);

  const releaseAudio = useCallback((
    generation?: number,
    expectedAudio?: HTMLAudioElement,
  ): void => {
    if (
      generation !== undefined
      && generationRef.current !== generation
    ) {
      return;
    }
    const audio = audioRef.current;
    if (expectedAudio && audio !== expectedAudio) {
      return;
    }
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
    }
    primingGenerationRef.current += 1;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    activeKeyRef.current = null;
    setPlaybackRecovery(null);
    setPlayingKey(null);
    setStatus("idle");
  }, []);

  const configureAudioPlayback = useCallback((
    audio: HTMLAudioElement,
    key: string,
    mode: VoiceSpeechMode,
    generation: number,
  ): void => {
    audio.onended = () => releaseAudio(generation, audio);
    audio.onerror = () => {
      if (generationRef.current !== generation || audioRef.current !== audio) {
        return;
      }
      setPlaybackRecovery({
        key,
        mode,
        message: getPlaybackErrorMessage(new Error("Audio playback failed.")),
      });
    };
  }, [releaseAudio]);

  const cleanupAudio = useCallback((): void => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
    }
    audioRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (unlockAudioUrlRef.current) {
      URL.revokeObjectURL(unlockAudioUrlRef.current);
      unlockAudioUrlRef.current = null;
    }
  }, []);

  const stop = useCallback((): void => {
    generationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    releaseAudio(generationRef.current);
  }, [releaseAudio]);

  const retryPlayback = useCallback(async (): Promise<void> => {
    const recovery = playbackRecovery;
    const audio = audioRef.current;
    const url = objectUrlRef.current;
    const generation = generationRef.current;
    setPlaybackRecovery(null);
    if (
      !recovery
      || activeKeyRef.current !== recovery.key
      || !audio
      || !url
    ) {
      if (recovery) {
        releaseAudio(generation);
      }
      return;
    }
    audio.pause();
    audio.currentTime = 0;
    try {
      setStatus("playing");
      await audio.play();
    } catch (playbackError) {
      if (generationRef.current !== generation || isAbortError(playbackError)) {
        return;
      }
      setPlaybackRecovery({
        key: recovery.key,
        mode: recovery.mode,
        message: getPlaybackErrorMessage(playbackError),
      });
    }
  }, [playbackRecovery, releaseAudio]);

  const play = useCallback(async (
    key: string,
    text: string,
    mode: VoiceSpeechMode,
  ): Promise<void> => {
    if (activeKeyRef.current === key) {
      stop();
      return;
    }
    stop();
    unlockAudio();
    activeKeyRef.current = key;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    let generatedAudioReady = false;
    setPlayingKey(key);
    setStatus("generating");
    try {
      const blob = await apiRequest("/api/voice/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode }),
        signal: controller.signal,
        responseType: "blob",
        action: mode === "summary" ? "Read response summary aloud" : "Read response aloud",
        fallbackMessage: "Failed to generate speech",
      });
      if (controller.signal.aborted || generationRef.current !== generation) {
        return;
      }
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      generatedAudioReady = true;
      const audio = audioRef.current;
      if (!audio) {
        throw new Error("Audio playback was not initialized.");
      }
      primingGenerationRef.current += 1;
      audio.pause();
      audio.src = url;
      configureAudioPlayback(audio, key, mode, generation);
      audio.load();
      setStatus("playing");
      await audio.play();
    } catch (playbackError) {
      if (controller.signal.aborted || isAbortError(playbackError)) {
        return;
      }
      if (generationRef.current === generation) {
        if (generatedAudioReady) {
          setPlaybackRecovery({
            key,
            mode,
            message: getPlaybackErrorMessage(playbackError),
          });
        } else {
          releaseAudio(generation);
          toast.error(String(playbackError));
        }
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [configureAudioPlayback, releaseAudio, stop, toast, unlockAudio]);

  useEffect(() => () => {
    generationRef.current += 1;
    requestControllerRef.current?.abort();
    releaseAudio(generationRef.current);
    cleanupAudio();
  }, [cleanupAudio, releaseAudio]);

  return { playingKey, status, playbackRecovery, play, retryPlayback, stop };
}
