import { useCallback, useMemo, useRef } from "react";
import { useVoiceRecorder } from "../../hooks/useVoiceRecorder";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import type { ConversationComposerVoice } from "./types";

export interface ConversationVoiceController {
  composer: ConversationComposerVoice;
  capabilities: ReturnType<typeof useVoiceSettings>["settings"]["capabilities"];
}

export function useConversationVoice(): ConversationVoiceController {
  const voiceSettings = useVoiceSettings();
  const draftSetterRef = useRef<((text: string) => void) | null>(null);
  const draftGetterRef = useRef<(() => string) | null>(null);
  const draftSubmitterRef = useRef<((text: string) => Promise<void>) | null>(null);

  const registerDraft = useCallback((
    setDraft: (text: string) => void,
    getDraft: () => string,
    submitDraft: (text: string) => Promise<void>,
  ): (() => void) => {
    draftSetterRef.current = setDraft;
    draftGetterRef.current = getDraft;
    draftSubmitterRef.current = submitDraft;
    return () => {
      if (draftSetterRef.current === setDraft) {
        draftSetterRef.current = null;
        draftGetterRef.current = null;
        draftSubmitterRef.current = null;
      }
    };
  }, []);

  const handleTranscript = useCallback((text: string): void => {
    const currentDraft = draftGetterRef.current?.().trim() ?? "";
    const nextDraft = currentDraft ? `${currentDraft}\n\n${text}` : text;
    draftSetterRef.current?.(nextDraft);
    void draftSubmitterRef.current?.(nextDraft);
  }, []);

  const recorder = useVoiceRecorder({
    enabled: voiceSettings.settings.capabilities.transcription.validated,
    canStart: () => draftGetterRef.current?.().trim() === "",
    onTranscript: handleTranscript,
  });

  const composer = useMemo<ConversationComposerVoice>(() => ({
    available: voiceSettings.settings.capabilities.transcription.validated,
    status: recorder.status,
    elapsedMs: recorder.elapsedMs,
    error: recorder.error,
    start: recorder.start,
    stop: recorder.stop,
    cancel: recorder.cancel,
    dismissError: recorder.dismissError,
    registerDraft,
  }), [
    recorder.cancel,
    recorder.dismissError,
    recorder.elapsedMs,
    recorder.error,
    recorder.start,
    recorder.status,
    recorder.stop,
    registerDraft,
    voiceSettings.settings.capabilities.transcription.validated,
  ]);

  return {
    composer,
    capabilities: voiceSettings.settings.capabilities,
  };
}
