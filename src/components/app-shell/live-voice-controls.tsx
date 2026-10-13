/**
 * Idle sidebar launcher and the persistent bottom-only Live control bar.
 */

import type { SidebarAction } from "@pablozaiden/webapp/web";
import type { UseLiveVoiceResult } from "../../hooks/useLiveVoice";
import { CloseIcon, MicrophoneIcon } from "../common";

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
    id: "live-voice", title: label, label, icon: <MicrophoneIcon />,
    onAction: () => {
      if (voice.available) void voice.start();
      else onConfigure();
    },
  }];
}

export function LiveVoiceSidebarBar({ voice }: { voice: UseLiveVoiceResult }) {
  if (!voice.busy) return null;
  const status = voiceStatusLabel(voice);
  const stopLabel = voice.status === "connecting" ? "Cancel connecting Live voice"
    : voice.status === "closing" ? "Ending Live voice" : "Stop Live voice";
  const muteLabel = voice.muted ? "Unmute Live microphone" : "Mute Live microphone";
  return (
    <div role="group" aria-label="Live voice controls"
      className="flex min-w-0 items-center gap-2 p-1.5">
      <span className="inline-flex shrink-0"><VoiceIndicator voice={voice} /></span>
      <div className="min-w-0 flex-1">
        <span className="block text-xs font-semibold">Live</span>
        <span role="status" title={status} className="block truncate text-xs text-slate-500 dark:text-slate-400">{status}</span>
      </div>
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
    </div>
  );
}
