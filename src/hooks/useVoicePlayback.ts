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

function getPlaybackErrorMessage(error: unknown, mode: VoiceSpeechMode): string {
  if (getErrorName(error) === "NotAllowedError") {
    const actionLabel = mode === "summary" ? "Read summary" : "Read aloud";
    return `The browser blocked audio playback. Try ${actionLabel} again to allow audio.`;
  }
  return String(error);
}

export interface UseVoicePlaybackResult {
  playingKey: string | null;
  status: "idle" | "generating" | "playing";
  play: (key: string, text: string, mode: VoiceSpeechMode) => Promise<void>;
  stop: () => void;
}

export function useVoicePlayback(): UseVoicePlaybackResult {
  const toast = useToast();
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "generating" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const unlockAudioRef = useRef<HTMLAudioElement | null>(null);
  const unlockAudioUrlRef = useRef<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const unlockAudio = useCallback((): void => {
    // Prime an inaudible media element while the click activation is live;
    // the TTS response arrives after the browser's activation window expires.
    let audio = unlockAudioRef.current;
    if (!audio) {
      const url = createSilentAudioUrl();
      unlockAudioUrlRef.current = url;
      audio = new Audio(url);
      audio.preload = "auto";
      audio.setAttribute("playsinline", "");
      unlockAudioRef.current = audio;
    }
    audio.pause();
    audio.currentTime = 0;
    void audio.play().then(
      () => {
        audio.pause();
        audio.currentTime = 0;
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
      audio.removeAttribute("src");
      audio.load();
    }
    audioRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    activeKeyRef.current = null;
    setPlayingKey(null);
    setStatus("idle");
  }, []);

  const cleanupUnlockAudio = useCallback((): void => {
    const audio = unlockAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    unlockAudioRef.current = null;
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
      const audio = new Audio(url);
      audioRef.current = audio;
      setStatus("playing");
      audio.onended = () => releaseAudio(generation, audio);
      audio.onerror = () => {
        if (generationRef.current !== generation || audioRef.current !== audio) {
          return;
        }
        releaseAudio(generation, audio);
        toast.error("The generated audio could not be played.");
      };
      await audio.play();
    } catch (playbackError) {
      if (playbackError instanceof Error && playbackError.name === "AbortError") {
        return;
      }
      if (generationRef.current === generation) {
        releaseAudio(generation);
        toast.error(getPlaybackErrorMessage(playbackError, mode));
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [releaseAudio, stop, toast, unlockAudio]);

  useEffect(() => () => {
    generationRef.current += 1;
    requestControllerRef.current?.abort();
    releaseAudio(generationRef.current);
    cleanupUnlockAudio();
  }, [cleanupUnlockAudio, releaseAudio]);

  return { playingKey, status, play, stop };
}
