/**
 * App-shell-owned Live media, lifecycle and revisioned originating UI context.
 */

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { useToast, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { LiveVoiceCallState } from "@/shared";
import type { LiveVoiceUiContext } from "@/shared/live-voice";
import { apiRequest } from "../lib/api-client";
import { LiveVoiceBrowser } from "../lib/live-voice-browser";
import { acquireVoiceAudio } from "../lib/voice-audio-ownership";
import { getClankyClientId } from "../lib/clanky-client-id";
import { getStoredNewTaskPlanningPreferences } from "../lib/new-task-planning-preferences";
import { useRealtimeStream } from "./useRealtimeStream";
import type { LiveVoiceActivityEvent } from "@/shared/live-voice";
import { getStoredTaskModelPreference, getStoredTaskCheapModelPreference } from "../lib/model-selection-preferences";

interface LiveVoiceUiState {
  status: "idle" | "connecting" | "active" | "closing";
  muted: boolean;
  speaking: boolean;
  processing: boolean;
  playbackBlocked: boolean;
  intention: string | null;
}
const INITIAL_STATE: LiveVoiceUiState = {
  status: "idle", muted: false, speaking: false, processing: false, playbackBlocked: false, intention: null,
};
interface BrowserCall {
  browser: LiveVoiceBrowser;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  ending?: Promise<void>;
  starting?: Promise<void>;
  releaseAudio: () => void;
  heartbeat?: () => Promise<void>;
  failed?: string;
}
export interface UseLiveVoiceResult extends LiveVoiceUiState {
  available: boolean;
  busy: boolean;
  callId: string | null;
  start: () => Promise<void>;
  end: () => Promise<void>;
  toggleMute: () => void;
  playAudio: () => Promise<void>;
  getContext: () => LiveVoiceUiContext;
}

export const LiveVoiceContext = createContext<UseLiveVoiceResult | null>(null);

export function useLiveVoice(options: { enabled: boolean; route: WebAppRoute }): UseLiveVoiceResult {
  const toast = useToast();
  const [state, setState] = useState<LiveVoiceUiState>(INITIAL_STATE);
  const [callId, setCallId] = useState<string | null>(null);
  const active = useRef<BrowserCall | null>(null);
  const mounted = useRef(true);
  const endRef = useRef<() => Promise<void>>(async () => {});
  const context = useRef<LiveVoiceUiContext>({ revision: 0, route: { view: "home" } });
  const safeRoute = Object.fromEntries(Object.entries(options.route).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const routeJson = JSON.stringify(safeRoute);
  const currentRouteJson = JSON.stringify(context.current.route);
  if (currentRouteJson !== routeJson) {
    context.current = { revision: context.current.revision + 1, route: safeRoute };
  }
  const getContext = useCallback((): LiveVoiceUiContext => {
    const taskModel = getStoredTaskModelPreference();
    const cheapModel = getStoredTaskCheapModelPreference();
    const { revision, ...previous } = context.current;
    const next = {
      route: context.current.route,
      planningPreferences: getStoredNewTaskPlanningPreferences() ?? undefined,
      modelPreferences: {
        taskModelJson: taskModel ? JSON.stringify(taskModel) : null,
        cheapModelJson: cheapModel ? JSON.stringify(cheapModel) : null,
      },
    };
    if (JSON.stringify(previous) !== JSON.stringify(next)) context.current = { revision: revision + 1, ...next };
    return context.current;
  }, []);

  const end = useCallback(async (): Promise<void> => {
    const call = active.current;
    if (!call) return;
    if (call.ending) return await call.ending;
    call.controller.abort();
    clearTimeout(call.timer);
    if (mounted.current) setState((current) => ({ ...current, status: "closing", speaking: false, intention: null }));
    call.ending = (async () => {
      let failure = call.failed;
      try {
        await call.browser.releaseMicrophone();
        try { await call.starting; }
        catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) failure ??= String(error);
        }
        if (call.browser.callId) {
          const result = await apiRequest<LiveVoiceCallState>(
            `/api/voice/live/${encodeURIComponent(call.browser.callId)}/close`,
            { method: "POST", keepalive: true, signal: AbortSignal.timeout(15_000),
              body: JSON.stringify({ clientId: getClankyClientId() }),
              headers: { "Content-Type": "application/json" }, action: "End Live voice" },
          );
          failure ??= result.error ?? undefined;
        }
      } catch (error) { failure ??= String(error); }
      finally {
        try { await call.browser.dispose(); } catch (error) { failure ??= String(error); }
        call.releaseAudio();
        if (active.current === call) {
          active.current = null;
          if (mounted.current) { setState(INITIAL_STATE); setCallId(null); }
        }
        if (failure && mounted.current) toast.error(failure);
      }
    })();
    return await call.ending;
  }, [toast]);
  endRef.current = end;

  const start = useCallback(async (): Promise<void> => {
    if (!options.enabled || active.current) return;
    let releaseAudio: (() => void) | undefined;
    try {
      releaseAudio = acquireVoiceAudio("live");
      const browser = new LiveVoiceBrowser({
        speaking: (speaking) => { if (mounted.current) setState((current) => ({ ...current, speaking })); },
        playbackBlocked: (playbackBlocked) => { if (mounted.current) setState((current) => ({ ...current, playbackBlocked })); },
        failure: (message) => { if (active.current) active.current.failed = message; void endRef.current(); },
        closed: () => { void endRef.current(); },
      });
      const call: BrowserCall = { browser, controller: new AbortController(), releaseAudio };
      active.current = call;
      setState({ ...INITIAL_STATE, status: "connecting" });
      call.starting = browser.connect(getContext, call.controller.signal);
      try { await call.starting; }
      catch (error) {
        if (!call.controller.signal.aborted) call.failed = String(error);
        call.starting = undefined;
        await endRef.current();
        return;
      }
      call.starting = undefined;
      if (active.current !== call || call.ending || !mounted.current) return;
      setCallId(browser.callId!);
      setState((current) => ({ ...current, status: "active" }));
      let heartbeatInFlight = false;
      let heartbeatDirty = false;
      call.heartbeat = async (): Promise<void> => {
        if (call.ending || active.current !== call) return;
        if (heartbeatInFlight) { heartbeatDirty = true; return; }
        clearTimeout(call.timer);
        heartbeatInFlight = true;
        try {
          do {
            heartbeatDirty = false;
            const result = await apiRequest<LiveVoiceCallState>(
              `/api/voice/live/${encodeURIComponent(browser.callId!)}/heartbeat`,
              { method: "POST", signal: AbortSignal.any([call.controller.signal, AbortSignal.timeout(5_000)]),
                body: JSON.stringify({ clientId: getClankyClientId(), context: getContext() }),
                headers: { "Content-Type": "application/json" }, action: "Check Live voice" },
            );
            if (call.ending || active.current !== call) return;
            setState((current) => ({ ...current, processing: result.processing, intention: result.intention }));
            if (["closed", "failed"].includes(result.status)) {
              call.failed = result.error ?? undefined;
              await endRef.current();
              return;
            }
          } while (heartbeatDirty);
        } catch (error) {
          if (!call.controller.signal.aborted) { call.failed = String(error); await endRef.current(); }
        } finally {
          heartbeatInFlight = false;
          if (!call.ending && active.current === call) call.timer = setTimeout(() => void call.heartbeat?.(), 10_000);
        }
      };
      await call.heartbeat();
    } catch (error) {
      releaseAudio?.();
      toast.error(String(error));
    }
  }, [options.enabled, getContext, toast]);

  useEffect(() => { void active.current?.heartbeat?.(); }, [routeJson]);
  useEffect(() => {
    mounted.current = true;
    const pagehide = (): void => { void endRef.current(); };
    window.addEventListener("pagehide", pagehide);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", pagehide);
      void endRef.current();
    };
  }, []);
  useRealtimeStream<LiveVoiceActivityEvent>({
    enabled: options.enabled || callId !== null,
    filters: { clientId: getClankyClientId() },
    predicate: (event) => event.type === "voice.activity" && event.callId === callId,
    onEvent: (event) => setState((current) => ({ ...current, processing: event.processing, intention: event.intention })),
    onReconnect: () => { void active.current?.heartbeat?.(); },
  });
  const toggleMute = useCallback((): void => {
    setState((current) => {
      const muted = !current.muted;
      active.current?.browser.mute(muted);
      return { ...current, muted };
    });
  }, []);
  const playAudio = useCallback(async (): Promise<void> => { await active.current?.browser.playAudio(); }, []);
  return { ...state, available: options.enabled, busy: state.status !== "idle", callId, start, end, toggleMute, playAudio, getContext };
}
