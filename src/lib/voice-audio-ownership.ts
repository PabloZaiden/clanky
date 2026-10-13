/**
 * One tab-wide owner for Live, recording/transcription, and Piper playback.
 */

import { useSyncExternalStore } from "react";

type AudioKind = "live" | "talk" | "piper";
interface AudioOwner { kind: AudioKind; token: symbol; stop?: () => void }
let owner: AudioOwner | null = null;
const listeners = new Set<() => void>();
function emit(): void { for (const listener of listeners) listener(); }

export function acquireVoiceAudio(kind: AudioKind, stop?: () => void): () => void {
  if (kind === "live" && owner?.kind === "piper") owner.stop?.();
  if (owner) {
    throw new Error(owner.kind === "live"
      ? "End Live voice before starting Talk or read aloud."
      : owner.kind === "talk" ? "Finish or cancel Talk before starting Live voice."
        : "Another audio operation is still active.");
  }
  const token = Symbol(kind);
  owner = { kind, token, stop };
  emit();
  return () => {
    if (owner?.token !== token) return;
    owner = null;
    emit();
  };
}

export function useLiveVoiceBusy(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => owner?.kind === "live",
    () => false,
  );
}
