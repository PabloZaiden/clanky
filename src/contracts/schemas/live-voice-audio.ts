/**
 * Allowlisted browser media diagnostics; never accepts media or transport addresses.
 */

import { z } from "zod";

export const LIVE_AUDIO_DIAGNOSTICS_MAX_BYTES = 32_768;
export const LIVE_AUDIO_DIAGNOSTICS_BATCH_SIZE = 8;
export const LIVE_AUDIO_SAMPLE_INTERVAL_MS = 5_000;
const number = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const metric = number.nullable();
const version = z.string().regex(/^\d+(?:[._]\d+)*$/).max(32).nullable();

export const LiveAudioEventSchema = z.enum([
  "initial", "sample", "stats_failed", "buffer_changed", "buffer_unsupported", "buffer_failed",
  "microphone_acquired", "microphone_failed", "microphone_released", "microphone_ended", "microphone_mute",
  "microphone_unmute", "mute_changed", "remote_track", "remote_ended", "remote_mute",
  "remote_unmute", "peer_state", "ice_state", "context_state", "session_state",
  "device_change", "visibility", "pagehide", "play_requested", "play_started",
  "play_failed", "context_resume_failed", "audio_waiting", "audio_stalled",
  "audio_error", "audio_pause", "audio_ended", "delivery_failed", "delivery_recovered", "disposed",
]);
export const LiveAudioErrorSchema = z.enum([
  "AbortError", "NotAllowedError", "NotFoundError", "NotReadableError", "NotSupportedError",
  "InvalidStateError", "OperationError", "OverconstrainedError", "SecurityError",
  "RangeError", "TimeoutError", "TypeError", "unknown",
]).nullable();

const MicrophoneSchema = z.object({
  readyState: z.enum(["live", "ended"]).nullable(),
  enabled: z.boolean().nullable(),
  muted: z.boolean().nullable(),
  echoCancellation: z.union([z.boolean(), z.literal("all"), z.literal("remote-only")]).nullable(),
  noiseSuppression: z.boolean().nullable(),
  autoGainControl: z.boolean().nullable(),
  sampleRate: metric,
  sampleSize: metric,
  channelCount: metric,
  latencySeconds: metric,
}).strict();

export const LiveAudioMediaSchema = z.object({
  peerState: z.enum(["new", "connecting", "connected", "disconnected", "failed", "closed"]),
  iceState: z.enum(["new", "checking", "connected", "completed", "disconnected", "failed", "closed"]),
  audio: z.object({
    paused: z.boolean(), muted: z.boolean(), volume: z.number().min(0).max(1),
    readyState: z.number().int().min(0).max(4), errorCode: z.number().int().min(1).max(4).nullable(),
    currentTimeSeconds: metric,
  }).strict(),
  context: z.object({
    state: z.enum(["suspended", "running", "closed", "interrupted"]),
    sampleRate: metric,
    baseLatencySeconds: metric, outputLatencySeconds: metric,
  }).strict(),
  session: z.object({
    supported: z.boolean(),
    type: z.enum(["auto", "playback", "transient", "transient-solo", "ambient", "play-and-record"]).nullable(),
    state: z.enum(["inactive", "active", "interrupted"]).nullable(),
  }).strict(),
  microphone: MicrophoneSchema,
  remote: z.object({
    readyState: z.enum(["live", "ended"]).nullable(),
    muted: z.boolean().nullable(),
    enabled: z.boolean().nullable(),
  }).strict(),
  visibility: z.enum(["visible", "hidden"]),
  requestedTargetMs: z.literal(200).nullable(),
  targetSupported: z.boolean(),
  configuredTargetMs: metric,
}).strict();

export const LiveAudioMetricsSchema = z.object({
  codec: z.object({
    mimeType: z.string().regex(/^audio\/[a-zA-Z0-9.+-]+$/).max(64),
    clockRate: metric, channels: metric,
  }).strict().nullable(),
  packetsReceived: metric, bytesReceived: metric,
  packetsLost: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  packetsDiscarded: metric, jitterSeconds: metric,
  totalSamplesReceived: metric, concealedSamples: metric, silentConcealedSamples: metric,
  concealmentEvents: metric, insertedSamplesForDeceleration: metric, removedSamplesForAcceleration: metric,
  jitterBufferDelaySeconds: metric, jitterBufferTargetDelaySeconds: metric,
  jitterBufferMinimumDelaySeconds: metric, jitterBufferEmittedCount: metric,
  audioLevel: z.number().min(0).max(1).nullable(), totalAudioEnergy: metric,
  totalSamplesDurationSeconds: metric,
  roundTripTimeSeconds: metric, availableIncomingBitrate: metric, availableOutgoingBitrate: metric,
  interval: z.object({
    durationMs: metric,
    packetsReceived: metric, packetsLost: z.number().finite().nullable(), packetsDiscarded: metric,
    totalSamplesReceived: metric, concealedSamples: metric, concealmentEvents: metric,
    insertedSamplesForDeceleration: metric, removedSamplesForAcceleration: metric,
    actualDelayMs: metric, targetDelayMs: metric, minimumDelayMs: metric,
    concealmentRatio: z.number().min(0).max(1).nullable(),
  }).strict().nullable(),
}).strict();

export const LiveAudioEnvironmentSchema = z.object({
  browser: z.enum(["safari", "chromium", "firefox", "unknown"]),
  browserVersion: version,
  os: z.enum(["ios", "macos", "windows", "android", "linux", "unknown"]),
  osVersion: version,
  secureContext: z.boolean(),
  requestedProcessing: z.object({
    echoCancellation: z.literal(true), noiseSuppression: z.literal(true), autoGainControl: z.literal(true),
  }).strict(),
  captureConstraints: z.object({
    echoCancellation: z.boolean(), noiseSuppression: z.boolean(), autoGainControl: z.boolean(),
  }).strict(),
}).strict();

export const LiveAudioRecordSchema = z.object({
  sequence: number.int().positive(),
  elapsedMs: number,
  observedAt: z.iso.datetime(),
  event: LiveAudioEventSchema,
  error: LiveAudioErrorSchema,
  httpStatus: z.number().int().min(100).max(599).optional(),
  media: LiveAudioMediaSchema,
  environment: LiveAudioEnvironmentSchema.optional(),
  metrics: LiveAudioMetricsSchema.optional(),
}).strict();

export const LiveAudioDiagnosticsRequestSchema = z.object({
  clientId: z.string().uuid(),
  attemptId: z.string().uuid(),
  callId: z.string().uuid().nullable(),
  droppedRecords: number.int(),
  deliveryFailures: number.int(),
  records: z.array(LiveAudioRecordSchema).min(1).max(LIVE_AUDIO_DIAGNOSTICS_BATCH_SIZE),
}).strict();

export const LiveAudioDiagnosticsResponseSchema = z.object({
  success: z.literal(true),
  accepted: z.number().int().min(1).max(LIVE_AUDIO_DIAGNOSTICS_BATCH_SIZE),
  lastSequence: number.int().positive(),
}).strict();

export type LiveAudioEvent = z.infer<typeof LiveAudioEventSchema>;
export type LiveAudioError = z.infer<typeof LiveAudioErrorSchema>;
export type LiveAudioMedia = z.infer<typeof LiveAudioMediaSchema>;
export type LiveAudioMetrics = z.infer<typeof LiveAudioMetricsSchema>;
export type LiveAudioEnvironment = z.infer<typeof LiveAudioEnvironmentSchema>;
export type LiveAudioRecord = z.infer<typeof LiveAudioRecordSchema>;
export type LiveAudioDiagnosticsRequest = z.infer<typeof LiveAudioDiagnosticsRequestSchema>;
