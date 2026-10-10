import type { UseLiveVoiceResult } from "../../hooks/useLiveVoice";
import { Button, CloseIcon, MicrophoneIcon } from "../common";

export function LiveVoicePanel({ voice, agentStatus }: { voice: UseLiveVoiceResult; agentStatus: string }) {
  if (voice.status === "idle") return null;
  const connecting = voice.status === "connecting";
  const closing = voice.status === "closing";
  const active = voice.status === "active";
  return (
    <section aria-label="Live voice" className="shrink-0 border-t border-[var(--wapp-border-soft)] bg-[var(--wapp-surface)] px-3 py-3 text-[var(--wapp-text)] sm:px-4">
      <div className="mx-auto max-w-7xl space-y-2">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className={active && !voice.muted ? "animate-pulse text-red-500" : "text-[var(--wapp-muted)]"}><MicrophoneIcon /></span>
          <div className="min-w-0 flex-1">
            <p aria-live="polite" className="text-sm font-medium">
              {connecting ? "Connecting Live voice..." : closing ? "Ending call..." : !active ? "Live voice ended" : voice.speaking ? "Speaking" : voice.muted ? "Microphone muted" : "Listening"}
            </p>
            <p className="truncate text-xs text-[var(--wapp-muted)]">Agent: {agentStatus}</p>
          </div>
          {active ? <Button type="button" size="sm" variant="ghost" aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? "Unmute" : "Mute"}</Button> : null}
          {voice.busy ? (
            <Button type="button" size="sm" variant="ghost" disabled={closing} onClick={() => void voice.end()}>End call</Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" aria-label="Dismiss Live voice error" onClick={voice.dismissError}><CloseIcon /></Button>
          )}
        </div>
        {active && !voice.muted ? <p className="text-xs text-[var(--wapp-muted)]">Microphone audio is being sent to the Live provider.</p> : null}
        {voice.userCaption ? <p className="line-clamp-2 text-sm"><span className="text-[var(--wapp-muted)]">You: </span>{voice.userCaption}</p> : null}
        {voice.voiceCaption ? <p className="line-clamp-2 text-sm"><span className="text-[var(--wapp-muted)]">Voice: </span>{voice.voiceCaption}</p> : null}
        {voice.playbackBlocked ? <Button type="button" size="sm" variant="secondary" onClick={() => void voice.playAudio()}>Enable audio playback</Button> : null}
        {voice.error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{voice.error}</p> : null}
      </div>
    </section>
  );
}
