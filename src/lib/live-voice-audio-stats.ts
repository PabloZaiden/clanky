/**
 * Receiver interval measurements. Missing/reset counters do not become zero.
 */

import type { LiveAudioMetrics } from "@/contracts/schemas/live-voice-audio";
import { audioNumber, audioRecord } from "./live-voice-audio-state";

interface AudioStatsSample { id: string; timestamp: number; values: LiveAudioMetrics }

export class LiveAudioStats {
  private previous?: AudioStatsSample;

  read(report: RTCStatsReport): LiveAudioMetrics | undefined {
    let incoming: Record<string, unknown> | undefined;
    let pair: Record<string, unknown> | undefined;
    report.forEach((entry: unknown) => {
      const value = audioRecord(entry);
      if (value?.["type"] === "inbound-rtp" && value["kind"] === "audio") incoming = value;
      if (value?.["type"] === "transport" && typeof value["selectedCandidatePairId"] === "string") {
        pair = audioRecord(report.get(value["selectedCandidatePairId"]));
      }
    });
    if (!incoming) return undefined;
    const codec = typeof incoming["codecId"] === "string" ? audioRecord(report.get(incoming["codecId"])) : undefined;
    const mime = codec?.["mimeType"];
    const n = (key: string): number | null => audioNumber(incoming, key);
    const values: LiveAudioMetrics = {
      codec: typeof mime === "string" && /^audio\/[a-zA-Z0-9.+-]{1,58}$/.test(mime)
        ? { mimeType: mime, clockRate: audioNumber(codec, "clockRate"), channels: audioNumber(codec, "channels") } : null,
      packetsReceived: n("packetsReceived"), bytesReceived: n("bytesReceived"), packetsLost: n("packetsLost"),
      packetsDiscarded: n("packetsDiscarded"), jitterSeconds: n("jitter"), totalSamplesReceived: n("totalSamplesReceived"),
      concealedSamples: n("concealedSamples"), silentConcealedSamples: n("silentConcealedSamples"),
      concealmentEvents: n("concealmentEvents"), insertedSamplesForDeceleration: n("insertedSamplesForDeceleration"),
      removedSamplesForAcceleration: n("removedSamplesForAcceleration"), jitterBufferDelaySeconds: n("jitterBufferDelay"),
      jitterBufferTargetDelaySeconds: n("jitterBufferTargetDelay"), jitterBufferMinimumDelaySeconds: n("jitterBufferMinimumDelay"),
      jitterBufferEmittedCount: n("jitterBufferEmittedCount"), audioLevel: n("audioLevel"), totalAudioEnergy: n("totalAudioEnergy"),
      totalSamplesDurationSeconds: n("totalSamplesDuration"), roundTripTimeSeconds: audioNumber(pair, "currentRoundTripTime"),
      availableIncomingBitrate: audioNumber(pair, "availableIncomingBitrate"), availableOutgoingBitrate: audioNumber(pair, "availableOutgoingBitrate"),
      interval: null,
    };
    const id = typeof incoming["id"] === "string" ? incoming["id"] : "";
    const timestamp = n("timestamp");
    const previous = this.previous;
    if (previous && previous.id === id && timestamp !== null && timestamp > previous.timestamp) {
      values.interval = this.interval(values, previous.values, timestamp - previous.timestamp);
    }
    this.previous = timestamp === null ? undefined : { id, timestamp, values };
    return values;
  }

  private interval(next: LiveAudioMetrics, previous: LiveAudioMetrics, durationMs: number): LiveAudioMetrics["interval"] {
    for (const key of ["packetsReceived", "bytesReceived", "totalSamplesReceived", "jitterBufferEmittedCount"] as const) {
      const current = next[key];
      const before = previous[key];
      if (current !== null && before !== null && current < before) return null;
    }
    const delta = (key: keyof LiveAudioMetrics, signed = false): number | null => {
      const current = next[key];
      const before = previous[key];
      if (typeof current !== "number" || typeof before !== "number") return null;
      const value = current - before;
      return signed || value >= 0 ? value : null;
    };
    const emitted = delta("jitterBufferEmittedCount");
    const delay = (key: keyof LiveAudioMetrics): number | null => {
      const seconds = delta(key);
      return seconds !== null && emitted !== null && emitted > 0 ? 1_000 * seconds / emitted : null;
    };
    const received = delta("totalSamplesReceived");
    const concealed = delta("concealedSamples");
    return {
      durationMs, packetsReceived: delta("packetsReceived"), packetsLost: delta("packetsLost", true),
      packetsDiscarded: delta("packetsDiscarded"), totalSamplesReceived: received,
      concealedSamples: concealed, concealmentEvents: delta("concealmentEvents"),
      insertedSamplesForDeceleration: delta("insertedSamplesForDeceleration"),
      removedSamplesForAcceleration: delta("removedSamplesForAcceleration"),
      actualDelayMs: delay("jitterBufferDelaySeconds"), targetDelayMs: delay("jitterBufferTargetDelaySeconds"),
      minimumDelayMs: delay("jitterBufferMinimumDelaySeconds"),
      concealmentRatio: received !== null && received > 0 && concealed !== null && concealed <= received
        ? concealed / received : null,
    };
  }
}
