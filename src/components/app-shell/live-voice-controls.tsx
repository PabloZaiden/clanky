/**
 * Idle sidebar launcher and shared sidebar/floating Live controls.
 */

import type { SidebarAction } from "@pablozaiden/webapp/web";
import type { UseLiveVoiceResult } from "../../hooks/useLiveVoice";
import { CloseIcon, MicrophoneIcon, RefreshIcon } from "../common";

const CONTROL_BUTTON_CLASS_NAME = "wapp-action-menu-trigger wapp-action-menu-trigger-compact h-11 w-11 shrink-0";

function VoiceIndicator({ voice }: { voice: UseLiveVoiceResult }) {
  if (!voice.busy) return <MicrophoneIcon />;
  if (voice.processing && !voice.speaking || voice.status === "connecting" || voice.status === "closing") {
    return <span aria-hidden="true" className="h-4 w-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />;
  }
  return (
    <span aria-hidden="true" className={`inline-flex h-5 w-5 items-center justify-center gap-0.5 ${voice.muted ? "opacity-50" : ""}`}>
      {[2, 4, 5, 3].map((height, index) => (
        <span key={index} className={`w-0.5 rounded-sm bg-current ${voice.speaking ? "motion-safe:animate-bounce" : !voice.muted ? "motion-safe:animate-pulse" : ""}`}
          style={{ height: `${height * 3}px`, animationDelay: `${index * 100}ms` }} />
      ))}
    </span>
  );
}

function voiceStatusLabel(voice: UseLiveVoiceResult): string {
  if (voice.status === "connecting") return "Connecting";
  if (voice.status === "closing") return "Ending";
  if (voice.muted) return "Muted";
  if (voice.speaking) return "Speaking";
  if (voice.processing) return "Processing";
  return "Listening";
}

export function buildVoiceLauncherActions(voice: UseLiveVoiceResult, onConfigure: () => void): SidebarAction[] {
  if (voice.busy) return [];
  const label = voice.available ? "Start Live voice" : "Configure Live voice";
  return [{
    id: "live-voice", title: label, label, icon: <MicrophoneIcon />, systemImage: "mic",
    onAction: () => {
      if (voice.available) void voice.start();
      else onConfigure();
    },
  }];
}

export function LiveVoiceControls({ voice, expanded, onToggleExpanded }: {
  voice: UseLiveVoiceResult;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  if (!voice.busy) return null;
  const status = voiceStatusLabel(voice);
  const stopLabel = voice.status === "connecting" ? "Cancel connecting Live voice"
    : voice.status === "closing" ? "Ending Live voice" : "Stop Live voice";
  const muteLabel = voice.muted ? "Unmute Live microphone" : "Mute Live microphone";
  const placementLabel = expanded ? "Minimize Live voice to sidebar" : "Expand Live voice";
  return (
    <div role="group" aria-label="Live voice controls"
      className={`flex min-w-0 items-center ${expanded
        ? "clanky-live-voice-bar absolute inset-x-0 bottom-0 min-h-14 flex-wrap gap-x-1.5 gap-y-1 rounded-none border-t pt-1.5 pb-[max(var(--wapp-safe-area-bottom),0.375rem)] pl-[max(var(--wapp-main-safe-area-left),0.75rem)] pr-[max(var(--wapp-safe-area-right),0.75rem)] sm:min-h-[var(--wapp-sidebar-tabs-height)]"
        : "gap-1.5 p-1.5"}`}>
      <span className="inline-flex shrink-0"><VoiceIndicator voice={voice} /></span>
      <div className={`min-w-0 flex-1 ${expanded ? "sm:flex-none" : ""}`} role="status">
        <span className="block truncate text-xs font-semibold">Live</span>
        <span title={status} className="block truncate text-xs text-slate-500 dark:text-slate-400">{status}</span>
      </div>
      {expanded ? <p role="status" title={voice.intention ?? undefined}
        className="order-last m-0 min-h-8 w-full break-words text-xs leading-4 text-slate-500 sm:order-none sm:min-h-0 sm:w-auto sm:min-w-0 sm:flex-1 dark:text-slate-400">
        {voice.intention}
      </p> : null}
      <div className="flex shrink-0 items-center gap-1.5">
        {expanded ? <button type="button" className={CONTROL_BUTTON_CLASS_NAME}
          title="New Live conversation" aria-label="New Live conversation"
          disabled={voice.status !== "active"} onClick={() => void voice.startNewConversation()}>
          <span aria-hidden="true"><RefreshIcon /></span>
        </button> : null}
        {voice.status === "active" ? <button type="button" className={CONTROL_BUTTON_CLASS_NAME}
          title={muteLabel} aria-label={muteLabel} aria-pressed={voice.muted} onClick={voice.toggleMute}>
          <span aria-hidden="true" className="relative inline-flex">
            <MicrophoneIcon />
            {voice.muted ? <span className="absolute inset-x-0 top-1/2 h-0.5 -rotate-45 bg-current" /> : null}
          </span>
        </button> : null}
        {voice.status === "active" && voice.playbackBlocked ? <button type="button"
          className={CONTROL_BUTTON_CLASS_NAME} title="Enable Live audio playback" aria-label="Enable Live audio playback"
          onClick={() => void voice.playAudio()}>
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5 6 9H3v6h3l5 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
          </svg>
        </button> : null}
        <button type="button" className={CONTROL_BUTTON_CLASS_NAME} title={stopLabel} aria-label={stopLabel}
          disabled={voice.status === "closing"} onClick={() => void voice.end()}>
          <CloseIcon />
        </button>
        <button type="button" className={CONTROL_BUTTON_CLASS_NAME} title={placementLabel} aria-label={placementLabel}
          onClick={onToggleExpanded}>
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            {expanded ? <path strokeLinecap="round" strokeLinejoin="round" d="m19 5-6 6m0-6v6h6M5 19l6-6m-6 0h6v6" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="m13 11 6-6m-6 0h6v6M11 13l-6 6m0-6v6h6" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
