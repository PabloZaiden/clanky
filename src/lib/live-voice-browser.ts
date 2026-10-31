/**
 * Browser-owned microphone, WebRTC media and deterministic media disposal.
 */

import type { LiveVoiceSessionResponse } from "@/shared";
import { getClankyClientId } from "./clanky-client-id";
import { parseApiError } from "./api-error";
import { appFetch } from "./public-path";
import type { ControlClientContext } from "@/shared/control-interactions";
import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("live-voice-browser");

async function waitForIce(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const changed = (): void => { if (peer.iceGatheringState === "complete") finish(); };
    const aborted = (): void => finish(new DOMException("Voice call cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Voice network negotiation timed out.")), 10_000);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted(); else changed();
  });
}

async function createAndGatherOffer(peer: RTCPeerConnection, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException("Voice call cancelled.", "AbortError");
  await peer.setLocalDescription(await peer.createOffer());
  await waitForIce(peer, signal);
  const sdp = peer.localDescription?.sdp;
  if (!sdp) throw new Error("The voice connection could not be prepared.");
  return sdp;
}

export async function createLiveVoiceValidationOffer(signal: AbortSignal): Promise<string> {
  const peer = new RTCPeerConnection();
  try {
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("oai-events");
    return await createAndGatherOffer(peer, signal);
  } finally {
    peer.close();
  }
}

export class LiveVoiceBrowser {
  callId?: string;
  private readonly peer = new RTCPeerConnection();
  private readonly audio = new Audio();
  private readonly audioContext = new AudioContext();
  private microphone?: MediaStream;
  private events?: RTCDataChannel;
  private volumeTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private releasing = false;
  private lastSpeaking = false;
  private silentInput?: MediaStream;
  private oscillator?: OscillatorNode;
  private volumeSource?: MediaStreamAudioSourceNode;
  private remoteStream?: MediaStream;

  constructor(private readonly update: {
    speaking: (speaking: boolean) => void;
    playbackBlocked: (blocked: boolean) => void;
    failure: (message: string) => void;
    closed: () => void;
  }) {
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "");
    this.peer.ontrack = (event) => {
      if (this.stopped) return;
      const stream = new MediaStream([event.track]);
      this.remoteStream?.getTracks().forEach((track) => track.stop());
      this.remoteStream = stream;
      this.audio.srcObject = stream;
      void this.playAudio();
      this.monitorVolume(stream);
    };
    this.peer.onconnectionstatechange = () => {
      if (!this.stopped && !this.releasing && ["failed", "disconnected"].includes(this.peer.connectionState)) {
        this.update.failure("The voice connection was interrupted. Start a new call to reconnect.");
      }
    };
  }

  async connect(getContext: () => ControlClientContext, signal: AbortSignal, newConversation = false): Promise<void> {
    await this.audioContext.resume();
    const microphone = await this.acquireMicrophone();
    if (this.stopped || signal.aborted) {
      microphone.getTracks().forEach((track) => track.stop());
      throw new DOMException("Voice call cancelled.", "AbortError");
    }
    this.microphone = microphone;
    for (const track of microphone.getAudioTracks()) {
      track.onended = () => {
        if (!this.stopped) this.update.failure("The microphone is no longer available.");
      };
      this.peer.addTrack(track, microphone);
    }
    const channel = this.events = this.peer.createDataChannel("oai-events");
    const ready = Promise.withResolvers<void>();
    void ready.promise.catch(() => { /* The connect path consumes this rejection after SDP exchange. */ });
    channel.onmessage = (message) => {
      try {
        if (typeof message.data !== "string" || message.data.length > 1_000_000) throw new Error("Invalid Live event.");
        const event: unknown = JSON.parse(message.data);
        if (!event || typeof event !== "object" || !("type" in event)) throw new Error("Invalid Live event.");
        if (event.type === "session.started") ready.resolve();
        if (event.type === "session.closed") { this.update.closed(); return; }
        if (event.type === "error") { this.update.failure("Live reported a call error."); return; }
        // Functions have one executor: Clanky's sideband. No captions are retained.
      } catch {
        this.update.failure("The voice connection returned invalid data.");
      }
    };
    channel.onclose = () => {
      ready.reject(new Error("The Live event channel closed."));
      if (!this.stopped && !this.releasing) this.update.failure("The voice connection ended.");
    };
    const sdp = await createAndGatherOffer(this.peer, signal);
    const response = await appFetch("/api/voice/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp, clientId: getClankyClientId(), context: getContext(), newConversation }),
      signal,
    });
    if (!response.ok) {
      const error = await parseApiError(response, "The Live call could not be started.");
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter && Number.isFinite(Number(retryAfter))
          ? Math.max(1, Math.ceil(Number(retryAfter)))
          : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(1, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1_000)) : 60;
        throw new Error(`Live is rate limited. Wait ${seconds} seconds before starting another call.`, { cause: error });
      }
      throw error;
    }
    const session: LiveVoiceSessionResponse = await response.json();
    this.callId = session.call.id;
    if (this.stopped || signal.aborted) throw new DOMException("Voice call cancelled.", "AbortError");
    await this.peer.setRemoteDescription({ type: "answer", sdp: session.sdp });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => ready.reject(new DOMException("Voice call cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([
        ready.promise,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Live did not start in time.")), 10_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private async acquireMicrophone(): Promise<MediaStream> {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  mute(muted: boolean): void {
    this.microphone?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (this.events?.readyState === "open") {
      this.events.send(JSON.stringify({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" }));
    }
  }

  async playAudio(): Promise<void> {
    if (this.stopped) return;
    try { await this.audioContext.resume(); }
    catch (error) {
      log.warn("Optional speaking analyser could not resume", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    if (this.stopped) return;
    try {
      await this.audio.play();
      if (!this.stopped) this.update.playbackBlocked(false);
    } catch {
      if (!this.stopped) this.update.playbackBlocked(true);
    }
  }

  async releaseMicrophone(): Promise<void> {
    this.releasing = true;
    // Keep the negotiated media clock alive while sideband drains and closes,
    // but release the physical microphone immediately.
    if (!this.stopped && this.microphone) {
      const destination = this.audioContext.createMediaStreamDestination();
      const oscillator = this.audioContext.createOscillator();
      this.oscillator = oscillator;
      oscillator.frequency.value = 0;
      oscillator.connect(destination);
      oscillator.start();
      this.silentInput = destination.stream;
      const track = destination.stream.getAudioTracks()[0]!;
      this.microphone.getTracks().forEach((input) => { input.onended = null; input.stop(); });
      await Promise.all(this.peer.getSenders().filter((sender) => sender.track?.kind === "audio").map((sender) => sender.replaceTrack(track)));
      this.microphone = undefined;
    }
    this.microphone?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    this.audio.pause();
  }

  private monitorVolume(stream: MediaStream): void {
    clearInterval(this.volumeTimer);
    this.volumeSource?.disconnect();
    const source = this.audioContext.createMediaStreamSource(stream);
    this.volumeSource = source;
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    this.volumeTimer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const speaking = !this.audio.paused && samples.some((sample) => Math.abs(sample - 128) > 4);
      if (speaking !== this.lastSpeaking) { this.lastSpeaking = speaking; this.update.speaking(speaking); }
    }, 100);
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.volumeTimer);
    try { await this.releaseMicrophone(); }
    finally {
      this.silentInput?.getTracks().forEach((track) => track.stop());
      this.oscillator?.stop();
      this.oscillator?.disconnect();
      this.volumeSource?.disconnect();
      this.remoteStream?.getTracks().forEach((track) => track.stop());
      this.peer.ontrack = this.peer.onconnectionstatechange = null;
      if (this.events) { this.events.onmessage = this.events.onclose = null; this.events.close(); }
      this.peer.close();
      this.audio.pause();
      this.audio.srcObject = null;
      await this.audioContext.close();
    }
  }
}
