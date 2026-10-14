/**
 * One call's bounded metadata sampler and authenticated server delivery.
 */

import {
  LIVE_AUDIO_DIAGNOSTICS_BATCH_SIZE, LIVE_AUDIO_SAMPLE_INTERVAL_MS,
  LiveAudioDiagnosticsResponseSchema, LiveAudioRecordSchema,
  type LiveAudioEvent, type LiveAudioMetrics, type LiveAudioRecord,
} from "@/contracts/schemas/live-voice-audio";
import { appFetch } from "./public-path";
import { getClankyClientId } from "./clanky-client-id";
import { audioEnvironment, audioError, browserAudioSession, readAudioMedia } from "./live-voice-audio-state";
import { LiveAudioStats } from "./live-voice-audio-stats";

const MAX_QUEUED_RECORDS = 64;
const DELIVERY_TIMEOUT_MS = 5_000;

export class LiveVoiceAudioDiagnostics {
  readonly attemptId = crypto.randomUUID();
  callId?: string;
  private readonly startedAt = performance.now();
  private readonly stats = new LiveAudioStats();
  private readonly queue: LiveAudioRecord[] = [];
  private readonly listeners: Array<() => void> = [];
  private readonly trackListeners: Record<"microphone" | "remote", Array<() => void>> = { microphone: [], remote: [] };
  private readonly uploadAbort = new AbortController();
  private readonly warnings = new Set<string>();
  private microphone?: MediaStreamTrack;
  private receiver?: RTCRtpReceiver;
  private target: 200 | null;
  private sampleTimer?: ReturnType<typeof setTimeout>;
  private uploadTimer?: ReturnType<typeof setTimeout>;
  private sampleInFlight?: Promise<void>;
  private statsInFlight?: Promise<RTCStatsReport>;
  private uploadInFlight?: Promise<void>;
  private sequence = 0;
  private droppedRecords = 0;
  private deliveryFailures = 0;
  private deliveryFailed = false;
  private samplingStopped = false;
  private disposed = false;
  private keepalive = false;
  private retryAt = 0;

  constructor(private readonly options: {
    peer: RTCPeerConnection; audio: HTMLAudioElement; context: AudioContext;
    target: 200 | null; warning: (message: string) => void;
  }) {
    this.target = options.target;
    this.listen(options.peer, "connectionstatechange", "peer_state");
    this.listen(options.peer, "iceconnectionstatechange", "ice_state");
    this.listen(options.context, "statechange", "context_state");
    for (const event of ["waiting", "stalled", "error", "pause", "ended"] as const) {
      this.listen(options.audio, event, `audio_${event}`);
    }
    if (navigator.mediaDevices) this.listen(navigator.mediaDevices, "devicechange", "device_change");
    this.listen(document, "visibilitychange", "visibility");
    const session = browserAudioSession();
    if (session instanceof EventTarget) this.listen(session, "statechange", "session_state");
    const pagehide = (): void => { this.keepalive = true; this.record("pagehide"); void this.flush(); };
    window.addEventListener("pagehide", pagehide);
    this.listeners.push(() => window.removeEventListener("pagehide", pagehide));
    this.record("initial", undefined, { environment: audioEnvironment() });
    this.scheduleSample();
  }

  setMicrophone(track: MediaStreamTrack): void {
    this.microphone = track;
    this.watchTrack(track, "microphone");
    this.record("microphone_acquired");
  }

  setReceiver(receiver: RTCRtpReceiver): void {
    this.receiver = receiver;
    this.watchTrack(receiver.track, "remote");
    this.setTarget(this.target);
    this.record("remote_track");
    void this.sample();
  }

  setTarget(target: 200 | null): void {
    this.target = target;
    if (!this.receiver) return;
    if (!("jitterBufferTarget" in this.receiver)) {
      this.record("buffer_unsupported");
      if (target !== null) this.warn("buffer_unsupported", "This browser cannot apply the 200 ms Live buffer. Native automatic buffering remains active.");
      return;
    }
    try {
      this.receiver.jitterBufferTarget = target;
      this.record("buffer_changed");
    } catch (error) {
      this.record("buffer_failed", error);
      this.warn("buffer_failed", "The Live audio buffer target could not be applied. Check the server audio diagnostics.");
    }
  }

  record(event: LiveAudioEvent, error?: unknown, extra: Partial<Pick<LiveAudioRecord, "environment" | "metrics" | "httpStatus">> = {}): void {
    if (this.disposed) return;
    const record = LiveAudioRecordSchema.parse({
      sequence: ++this.sequence, elapsedMs: performance.now() - this.startedAt,
      observedAt: new Date().toISOString(),
      event, error: error === undefined ? null : audioError(error),
      media: readAudioMedia({ ...this.options, microphone: this.microphone, receiver: this.receiver, target: this.target }),
      ...extra,
    });
    if (this.queue.length >= MAX_QUEUED_RECORDS) {
      this.queue.shift();
      this.droppedRecords += 1;
      this.warn("queue_full", "Some Live audio diagnostics could not be retained for server delivery.");
    }
    this.queue.push(record);
    if (!this.samplingStopped && !this.uploadTimer) {
      this.uploadTimer = setTimeout(() => {
        this.uploadTimer = undefined;
        void this.flush();
      }, Math.max(250, this.retryAt - performance.now()));
    }
  }

  private listen(target: EventTarget, name: string, event: LiveAudioEvent): void {
    const listener = (): void => { this.record(event); };
    target.addEventListener(name, listener);
    this.listeners.push(() => target.removeEventListener(name, listener));
  }

  private watchTrack(track: MediaStreamTrack, role: "microphone" | "remote"): void {
    const cleanup = this.trackListeners[role];
    cleanup.splice(0).forEach((remove) => remove());
    for (const name of ["ended", "mute", "unmute"] as const) {
      const listener = (): void => { this.record(`${role}_${name}`); };
      track.addEventListener(name, listener);
      cleanup.push(() => track.removeEventListener(name, listener));
    }
  }

  private warn(key: string, message: string): void {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.options.warning(message);
  }

  private scheduleSample(): void {
    if (this.samplingStopped) return;
    this.sampleTimer = setTimeout(() => {
      this.sampleTimer = undefined;
      void this.sample().finally(() => this.scheduleSample());
    }, LIVE_AUDIO_SAMPLE_INTERVAL_MS);
  }

  async sample(): Promise<void> {
    if (this.sampleInFlight) return await this.sampleInFlight;
    this.sampleInFlight = this.collect();
    try { await this.sampleInFlight; } finally { this.sampleInFlight = undefined; }
  }

  private async collect(): Promise<void> {
    if (this.statsInFlight || this.disposed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A deadline cannot cancel getStats; retain its slot until the native promise settles.
      this.statsInFlight = this.options.peer.getStats().finally(() => {
        this.statsInFlight = undefined;
      });
      const report = await Promise.race([
        this.statsInFlight,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DOMException("Audio stats timed out.", "TimeoutError")), 2_000);
        }),
      ]);
      if (!this.disposed) {
        const metrics: LiveAudioMetrics | undefined = this.stats.read(report);
        this.record("sample", undefined, metrics ? { metrics } : {});
      }
    } catch (error) {
      if (!this.disposed) this.record("stats_failed", error);
    } finally { clearTimeout(timer); }
  }

  async flush(): Promise<void> {
    if (this.uploadInFlight) return await this.uploadInFlight;
    if (!this.queue.length || this.uploadAbort.signal.aborted) return;
    this.uploadInFlight = this.deliver();
    try { await this.uploadInFlight; } finally { this.uploadInFlight = undefined; }
  }

  private async deliver(): Promise<void> {
    while (this.queue.length && !this.uploadAbort.signal.aborted) {
      const records = this.queue.slice(0, LIVE_AUDIO_DIAGNOSTICS_BATCH_SIZE);
      let httpStatus: number | undefined;
      try {
        const response = await appFetch("/api/voice/live/audio-diagnostics", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: getClankyClientId(), attemptId: this.attemptId, callId: this.callId ?? null,
            droppedRecords: this.droppedRecords, deliveryFailures: this.deliveryFailures, records,
          }),
          signal: AbortSignal.any([this.uploadAbort.signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]),
          keepalive: this.keepalive,
        });
        httpStatus = response.status;
        if (!response.ok) throw new DOMException("Audio diagnostics delivery rejected.", "OperationError");
        const payload: unknown = await response.json();
        const ack = LiveAudioDiagnosticsResponseSchema.parse(payload);
        const lastSequence = records.at(-1)!.sequence;
        if (ack.accepted !== records.length || ack.lastSequence !== lastSequence) {
          throw new DOMException("Audio diagnostics acknowledgement mismatch.", "InvalidStateError");
        }
        while (this.queue[0] && this.queue[0].sequence <= lastSequence) this.queue.shift();
        if (this.deliveryFailed) {
          this.deliveryFailed = false;
          this.retryAt = 0;
          this.record("delivery_recovered");
        }
      } catch (error) {
        this.deliveryFailures += 1;
        this.deliveryFailed = true;
        this.retryAt = performance.now() + LIVE_AUDIO_SAMPLE_INTERVAL_MS;
        clearTimeout(this.uploadTimer);
        this.uploadTimer = undefined;
        this.record("delivery_failed", error, httpStatus ? { httpStatus } : {});
        this.warn("delivery_failed", "Live audio diagnostics could not reach the server. Audio remains active; pending diagnostics will retry while the call is open.");
        return;
      }
    }
  }

  async stopSampling(): Promise<void> {
    this.samplingStopped = true;
    clearTimeout(this.sampleTimer);
    clearTimeout(this.uploadTimer);
    this.listeners.splice(0).forEach((remove) => remove());
    Object.values(this.trackListeners).forEach((cleanup) => cleanup.splice(0).forEach((remove) => remove()));
    await this.sample();
  }

  async dispose(): Promise<void> {
    const timer = setTimeout(() => this.uploadAbort.abort(), DELIVERY_TIMEOUT_MS);
    try {
      this.record("disposed");
      await this.flush();
      if (this.queue.length && !this.uploadAbort.signal.aborted) await this.flush();
      if (this.queue.length) {
        this.warn("final_delivery_failed", "The call ended with audio diagnostics that could not be delivered to the server.");
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(this.uploadTimer);
      this.disposed = true;
      this.uploadAbort.abort();
      this.queue.length = 0;
    }
  }
}
