import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import type { VoiceSpeechMode } from "@/shared";

export interface UseVoicePlaybackResult {
  playingKey: string | null;
  play: (key: string, text: string, mode: VoiceSpeechMode) => Promise<void>;
  stop: () => void;
}

export function useVoicePlayback(): UseVoicePlaybackResult {
  const toast = useToast();
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  const releaseAudio = useCallback((): void => {
    const audio = audioRef.current;
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
  }, []);

  const stop = useCallback((): void => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    releaseAudio();
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
    activeKeyRef.current = key;
    const controller = new AbortController();
    requestControllerRef.current = controller;
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
      if (controller.signal.aborted) {
        return;
      }
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      setPlayingKey(key);
      audio.onended = releaseAudio;
      audio.onerror = () => {
        releaseAudio();
        toast.error("The generated audio could not be played.");
      };
      await audio.play();
    } catch (playbackError) {
      if (playbackError instanceof Error && playbackError.name === "AbortError") {
        return;
      }
      releaseAudio();
      toast.error(String(playbackError));
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [releaseAudio, stop, toast]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    releaseAudio();
  }, [releaseAudio]);

  return { playingKey, play, stop };
}
