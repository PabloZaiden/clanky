import { z } from "zod";

export const ClientPerformanceDetailSchema = z.enum(["summary", "recent"]);
export type ClientPerformanceDetail = z.infer<typeof ClientPerformanceDetailSchema>;
export const MAX_CLIENT_PERFORMANCE_SAMPLES = 32;

const nonnegativeInteger = z.int().nonnegative();
const millis = nonnegativeInteger.nullable();
const PerformancePhaseSchema = z.enum([
  "config", "client-ticket", "client-token", "chats", "chat-summary", "chat-snapshot",
  "workspaces", "automations", "automation-runs", "execution-hosts", "terminals",
  "startup-content", "chat-open", "frontend", "session-restore", "token-refresh", "socket-open",
  "subscription", "heartbeat", "foreground", "foreground-visible", "foreground-update",
  "foreground-realtime", "foreground-chat-snapshot", "navigation", "assets",
]);
const ClientPerformanceSampleSchema = z.object({
  phase: PerformancePhaseSchema,
  source: z.enum(["client", "resource-timing"]),
  startMs: nonnegativeInteger,
  durationMs: millis,
  outcome: z.enum(["pending", "ok", "error", "aborted", "timeout", "unchanged", "unobserved"]),
  foreground: nonnegativeInteger.nullable(),
  status: z.int().min(100).max(599).optional(),
  backgroundMs: nonnegativeInteger.optional(),
  screen: z.enum(["home", "chat"]).optional(),
  connection: z.enum(["reused", "reconnected"]).optional(),
  transcriptSource: z.enum(["available", "snapshot"]).optional(),
  snapshotMs: nonnegativeInteger.optional(),
  timing: z.object({
    dnsMs: millis,
    connectMs: millis,
    tlsMs: millis,
    requestToFirstByteMs: millis,
    downloadMs: millis,
    transferBytes: millis,
  }).strict().optional(),
}).strict();

export type ClientPerformanceSample = z.infer<typeof ClientPerformanceSampleSchema>;

export const ClientPerformanceStatsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }).strict(),
  z.object({ state: z.literal("empty") }).strict(),
  z.object({
    state: z.literal("captured"),
    detail: ClientPerformanceDetailSchema,
    mode: z.enum(["integrated", "remote"]),
    surface: z.enum(["browser", "native-webview"]),
    startedAt: z.enum(["navigation", "manual"]),
    connection: z.enum(["idle", "connecting", "open", "subscribed", "closed"]),
    sampleCount: nonnegativeInteger,
    discarded: nonnegativeInteger,
    websocketRtt: z.object({ count: nonnegativeInteger, p50Ms: millis, p95Ms: millis }).strict(),
    samples: z.array(ClientPerformanceSampleSchema).max(MAX_CLIENT_PERFORMANCE_SAMPLES),
  }).strict(),
]);
export type ClientPerformanceStats = z.infer<typeof ClientPerformanceStatsSchema>;
