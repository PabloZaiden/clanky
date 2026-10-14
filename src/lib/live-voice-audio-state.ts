/**
 * Safe browser media metadata without identifiers, addresses or error messages.
 */

import {
  LiveAudioErrorSchema, LiveAudioMediaSchema,
  type LiveAudioEnvironment, type LiveAudioError, type LiveAudioMedia,
} from "@/contracts/schemas/live-voice-audio";

export function audioRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function audioNumber(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value : null;
}

export function audioError(error: unknown): LiveAudioError {
  const name = error instanceof Error ? error.name : audioRecord(error)?.["name"];
  const parsed = LiveAudioErrorSchema.safeParse(name);
  return parsed.success ? parsed.data : "unknown";
}

export function audioEnvironment(): LiveAudioEnvironment {
  const ua = navigator.userAgent;
  const browser = /(?:Chrome|CriOS|Edg)\//.test(ua) ? "chromium"
    : /(?:Firefox|FxiOS)\//.test(ua) ? "firefox" : /Safari\//.test(ua) ? "safari" : "unknown";
  const browserVersion = /(?:Chrome|CriOS|Edg|Firefox|FxiOS|Version)\/(\d+(?:\.\d+)*)/.exec(ua)?.[1] ?? null;
  const ios = /(?:iPhone|iPad|iPod)/.test(ua) || /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const os = ios ? "ios" : /Android/.test(ua) ? "android" : /Windows/.test(ua) ? "windows"
    : /Mac/.test(ua) ? "macos" : /Linux/.test(ua) ? "linux" : "unknown";
  const osVersion = ios && /Macintosh/.test(ua) ? null
    : /(?:OS |Mac OS X |Android |Windows NT )(\d+(?:[._]\d+)*)/.exec(ua)?.[1] ?? null;
  const constraints = navigator.mediaDevices?.getSupportedConstraints() ?? {};
  return {
    browser, browserVersion, os, osVersion, secureContext: window.isSecureContext,
    requestedProcessing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    captureConstraints: {
      echoCancellation: constraints.echoCancellation === true,
      noiseSuppression: constraints.noiseSuppression === true,
      autoGainControl: constraints.autoGainControl === true,
    },
  };
}

export function browserAudioSession(): Record<string, unknown> | undefined {
  return "audioSession" in navigator ? audioRecord(navigator.audioSession) : undefined;
}

export function readAudioMedia(options: {
  peer: RTCPeerConnection; audio: HTMLAudioElement; context: AudioContext;
  microphone?: MediaStreamTrack; receiver?: RTCRtpReceiver; target: 200 | null;
}): LiveAudioMedia {
  const { peer, audio, context, microphone, receiver, target } = options;
  const settings = audioRecord(microphone?.getSettings());
  const session = browserAudioSession();
  const echo = settings?.["echoCancellation"];
  const boolean = (key: string): boolean | null => typeof settings?.[key] === "boolean" ? settings[key] : null;
  const snapshot = {
    peerState: peer.connectionState, iceState: peer.iceConnectionState,
    audio: { paused: audio.paused, muted: audio.muted, volume: audio.volume,
      readyState: audio.readyState, errorCode: audio.error?.code ?? null, currentTimeSeconds: audio.currentTime },
    context: { state: context.state, sampleRate: context.sampleRate,
      baseLatencySeconds: audioNumber(audioRecord(context), "baseLatency"),
      outputLatencySeconds: audioNumber(audioRecord(context), "outputLatency") },
    session: { supported: session !== undefined, type: session?.["type"] ?? null, state: session?.["state"] ?? null },
    microphone: {
      readyState: microphone?.readyState ?? null, enabled: microphone?.enabled ?? null, muted: microphone?.muted ?? null,
      echoCancellation: typeof echo === "boolean" || echo === "all" || echo === "remote-only" ? echo : null,
      noiseSuppression: boolean("noiseSuppression"), autoGainControl: boolean("autoGainControl"),
      sampleRate: audioNumber(settings, "sampleRate"), sampleSize: audioNumber(settings, "sampleSize"),
      channelCount: audioNumber(settings, "channelCount"), latencySeconds: audioNumber(settings, "latency"),
    },
    remote: { readyState: receiver?.track.readyState ?? null, muted: receiver?.track.muted ?? null,
      enabled: receiver?.track.enabled ?? null },
    visibility: document.visibilityState,
    requestedTargetMs: target,
    targetSupported: receiver !== undefined && "jitterBufferTarget" in receiver,
    configuredTargetMs: receiver && "jitterBufferTarget" in receiver
      ? audioNumber(audioRecord(receiver), "jitterBufferTarget") : null,
  };
  return LiveAudioMediaSchema.parse(snapshot);
}
