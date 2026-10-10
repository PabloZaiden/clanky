/**
 * Chat-scoped Live call UI state and server lease/finalization.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type { LiveVoiceCallState } from "@/shared";
import { apiRequest } from "../lib/api-client";
import { LiveVoiceBrowser } from "../lib/live-voice-browser";

interface LiveVoiceUiState {
  status: "idle" | "connecting" | "active" | "closing" | "error";
  muted: boolean;
  speaking: boolean;
  playbackBlocked: boolean;
  userCaption: string;
  voiceCaption: string;
  error: string | null;
}

const INITIAL_STATE: LiveVoiceUiState = {
  status: "idle", muted: false, speaking: false, playbackBlocked: false,
  userCaption: "", voiceCaption: "", error: null,
};

export interface UseLiveVoiceResult extends LiveVoiceUiState {
  available: boolean;
  busy: boolean;
  start: () => Promise<void>;
  end: () => Promise<void>;
  toggleMute: () => void;
  playAudio: () => Promise<void>;
  dismissError: () => void;
}

export function useLiveVoice(options: { chatId: string; enabled: boolean; isVisible: boolean }): UseLiveVoiceResult {
  const toast = useToast();
  const [state, setState] = useState<LiveVoiceUiState>(INITIAL_STATE);
  const active = useRef<{ browser: LiveVoiceBrowser; controller: AbortController; chatId: string; timer?: ReturnType<typeof setTimeout>; ending: boolean } | null>(null);
  const mounted = useRef(true);
  const endRef = useRef<() => Promise<void>>(async () => {});
  const mutedRef = useRef(false);

  const end = useCallback(async (): Promise<void> => {
    const call = active.current;
    if (!call || call.ending) return;
    call.ending = true;
    call.controller.abort();
    clearTimeout(call.timer);
    if (mounted.current) setState((current) => ({ ...current, status: "closing", speaking: false }));
    let failure: string | null = null;
    try {
      await call.browser.releaseMicrophone();
      if (call.browser.callId) {
        const result = await apiRequest<LiveVoiceCallState>(
          `/api/chats/${encodeURIComponent(call.chatId)}/live-voice/${encodeURIComponent(call.browser.callId)}/close`,
          { method: "POST", keepalive: true, signal: AbortSignal.timeout(35_000), action: "End Live voice" },
        );
        failure = result.error;
      }
    } catch (error) {
      failure = String(error);
    } finally {
      await call.browser.dispose();
      if (active.current === call) {
        active.current = null;
        if (mounted.current) {
          setState((current) => ({ ...INITIAL_STATE, status: failure || current.error ? "error" : "idle", error: failure ?? current.error }));
        } else if (failure) {
          toast.error(failure);
        }
      }
    }
  }, [toast]);
  endRef.current = end;

  const start = useCallback(async (): Promise<void> => {
    if (!options.enabled || !options.isVisible || active.current) return;
    setState({ ...INITIAL_STATE, status: "connecting" });
    const controller = new AbortController();
    let browser: LiveVoiceBrowser;
    try {
      browser = new LiveVoiceBrowser({
        caption: (speaker, delta) => {
          if (mounted.current) setState((current) => speaker === "user"
            ? { ...current, userCaption: `${current.userCaption}${delta}`.slice(-1_000) }
            : { ...current, voiceCaption: `${current.voiceCaption}${delta}`.slice(-1_000) });
        },
        speaking: (speaking) => { if (mounted.current) setState((current) => ({ ...current, speaking })); },
        playbackBlocked: (playbackBlocked) => { if (mounted.current) setState((current) => ({ ...current, playbackBlocked })); },
        failure: (error) => {
          if (mounted.current) setState((current) => ({ ...current, error }));
          void endRef.current();
        },
        closed: () => { void endRef.current(); },
      });
    } catch (error) {
      setState({ ...INITIAL_STATE, status: "error", error: String(error) });
      return;
    }
    const call = { browser, controller, chatId: options.chatId, timer: undefined as ReturnType<typeof setTimeout> | undefined, ending: false };
    active.current = call;
    mutedRef.current = false;
    try {
      await browser.connect(options.chatId, controller.signal);
      if (active.current !== call || call.ending || !mounted.current) return;
      setState((current) => ({ ...current, status: "active" }));
      async function heartbeat(): Promise<void> {
        if (call.ending || active.current !== call) return;
        try {
          const result = await apiRequest<LiveVoiceCallState>(
            `/api/chats/${encodeURIComponent(call.chatId)}/live-voice/${encodeURIComponent(browser.callId!)}/heartbeat`,
            { method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]), action: "Check Live voice" },
          );
          if (result.status === "closed" || result.status === "failed") {
            if (result.error && mounted.current) setState((current) => ({ ...current, error: result.error }));
            await endRef.current();
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            if (mounted.current) setState((current) => ({ ...current, error: String(error) }));
            await endRef.current();
          }
        } finally {
          if (!call.ending && active.current === call) call.timer = setTimeout(() => void heartbeat(), 10_000);
        }
      }
      call.timer = setTimeout(() => void heartbeat(), 10_000);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) {
        setState((current) => ({ ...current, error: String(error) }));
      }
      await endRef.current();
    }
  }, [options.chatId, options.enabled, options.isVisible]);

  useEffect(() => {
    mounted.current = true;
    setState(INITIAL_STATE);
    return () => { mounted.current = false; void endRef.current(); };
  }, [options.chatId]);
  useEffect(() => {
    if (!options.isVisible || !options.enabled) void endRef.current();
  }, [options.enabled, options.isVisible]);

  const toggleMute = useCallback((): void => {
    mutedRef.current = !mutedRef.current;
    active.current?.browser.mute(mutedRef.current);
    setState((current) => ({ ...current, muted: mutedRef.current }));
  }, []);
  const playAudio = useCallback(async (): Promise<void> => { await active.current?.browser.playAudio(); }, []);
  const dismissError = useCallback((): void => setState(INITIAL_STATE), []);
  return {
    ...state, available: options.enabled,
    busy: state.status === "connecting" || state.status === "active" || state.status === "closing",
    start, end, toggleMute, playAudio, dismissError,
  };
}
