import { isAbortError, isTimeoutError } from "@/lib/request-lifecycle";
import { readStorage, warnStorageIssue, writeStorage } from "./storage";

type Screen = "home" | "chat";
type Mode = "integrated" | "remote";
type Outcome = "pending" | "ok" | "error" | "aborted" | "timeout" | "unchanged" | "unobserved";
type HttpPhase =
  | "config" | "client-ticket" | "client-token" | "chats" | "chat-summary" | "chat-snapshot"
  | "workspaces" | "automations" | "automation-runs" | "execution-hosts" | "terminals";
type Phase = HttpPhase | "startup-content" | "chat-open" | "frontend" | "session-restore" | "token-refresh" | "socket-open" | "subscription"
  | "heartbeat" | "foreground" | "foreground-visible" | "foreground-update"
  | "foreground-realtime" | "foreground-chat-snapshot" | "navigation" | "assets";

interface Timing {
  dnsMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  requestToFirstByteMs: number | null;
  downloadMs: number | null;
  transferBytes: number | null;
}

interface Sample {
  phase: Phase;
  source: "client" | "resource-timing";
  startMs: number;
  durationMs: number | null;
  outcome: Outcome;
  foreground: number | null;
  status?: number;
  backgroundMs?: number;
  screen?: Screen;
  connection?: "reused" | "reconnected";
  transcriptSource?: "available" | "snapshot";
  snapshotMs?: number;
  timing?: Timing;
}

interface ChatOpening {
  chatId: string;
  hash: string;
  start: number;
  sample: Sample;
}

interface Foreground {
  id: number;
  start: number;
  socket: number;
  visible: Sample;
  realtime: Sample;
  update: Sample;
  snapshotObserved: boolean;
}

interface Capture {
  origin: number;
  startup?: Sample;
  chatOpening?: ChatOpening;
  samples: Sample[];
  discarded: number;
  foregroundCount: number;
  foreground?: Foreground;
  hiddenAt?: number;
  visibilityEpoch: number;
  observer?: PerformanceObserver;
}

type Connection = "idle" | "connecting" | "open" | "subscribed" | "closed";
const STORAGE_KEY = "clanky.performance-stats.enabled";
const MAX_SAMPLES = 1500;
const listeners = new Set<() => void>();
let capture: Capture | undefined;
let mode: Mode | undefined;
let version: string | undefined;
let browserDocument = false;
let socketId = 0;
let connection: Connection = "idle";
let panel = false;
let revision = 0;
let scheduled: ReturnType<typeof setTimeout> | undefined;

export function subscribePerformanceStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function performanceStatsRevision(): number { return revision; }
export function isPerformanceCaptureEnabled(): boolean { return capture !== undefined; }
export function performancePresentationCycle(): number { return capture ? capture.foreground?.id ?? 0 : -1; }

function notify(): void {
  if (scheduled !== undefined) clearTimeout(scheduled);
  scheduled = undefined;
  revision++;
  for (const listener of listeners) listener();
}

function scheduleNotification(): void {
  if (panel && scheduled === undefined) scheduled = setTimeout(notify, 500);
}

function add(owner: Capture, phase: Phase, start: number, source: Sample["source"]): Sample {
  const sample: Sample = {
    phase, source, startMs: Math.round(start - owner.origin), durationMs: null,
    outcome: "pending", foreground: owner.foreground && start >= owner.foreground.start ? owner.foreground.id : null,
  };
  if (owner.samples.length === MAX_SAMPLES) {
    owner.samples.shift();
    owner.discarded++;
  }
  owner.samples.push(sample);
  scheduleNotification();
  return sample;
}

function finish(sample: Sample, end: number, start: number, outcome: Outcome): void {
  sample.durationMs = Math.round(Math.max(0, end - start));
  sample.outcome = outcome;
  scheduleNotification();
}

export function beginPerformanceSpan(phase: Phase) {
  const owner = capture;
  if (!owner) return undefined;
  const start = performance.now();
  const sample = add(owner, phase, start, "client");
  const visibilityEpoch = owner.visibilityEpoch;
  const beganHidden = phase === "heartbeat" && document.hidden;
  return (outcome: Exclude<Outcome, "pending">, status?: number) => {
    if (capture !== owner || sample.durationMs !== null) return;
    if (status !== undefined) sample.status = status;
    if (phase === "heartbeat" && (beganHidden || owner.visibilityEpoch !== visibilityEpoch)) outcome = "aborted";
    finish(sample, performance.now(), start, outcome);
  };
}

export function performanceFailure(error: unknown): "aborted" | "timeout" | "error" {
  if (isAbortError(error)) return "aborted";
  if (isTimeoutError(error)) return "timeout";
  return "error";
}

function finishChatOpening(owner: Capture, outcome: "ok" | "aborted" | "timeout" | "error", end = performance.now()): void {
  const opening = owner.chatOpening;
  if (!opening) return;
  owner.chatOpening = undefined;
  finish(opening.sample, end, opening.start, outcome);
  if (panel) notify();
}

export function notePerformanceChatNavigation(chatId: string | undefined, navigation?: { hash: string; start: number }): void {
  const owner = capture;
  if (!owner) return;
  if (owner.chatOpening) finishChatOpening(owner, "aborted", navigation?.start);
  if (!chatId || !navigation || navigation.start < owner.origin || document.hidden) return;
  owner.chatOpening = { chatId, ...navigation, sample: add(owner, "chat-open", navigation.start, "client") };
  if (panel) notify();
}

function currentChatOpening(chatId: string): ChatOpening | undefined {
  const opening = capture?.chatOpening;
  return opening?.chatId === chatId && opening.hash === location.hash ? opening : undefined;
}

export function notePerformanceChatOpenSnapshot(chatId: string, start: number, end: number): void {
  const opening = currentChatOpening(chatId);
  if (!opening || end < opening.start || opening.sample.transcriptSource) return;
  opening.sample.transcriptSource = "snapshot";
  opening.sample.snapshotMs = Math.round(end - Math.max(start, opening.start));
}

export function notePerformanceChatOpenPaint(chatId: string): void {
  const owner = capture;
  const opening = currentChatOpening(chatId);
  if (!owner || !opening || document.hidden) return;
  opening.sample.transcriptSource ??= "available";
  finishChatOpening(owner, "ok");
}

export function notePerformanceChatOpenFailure(chatId: string, outcome: "aborted" | "timeout" | "error"): void {
  const owner = capture;
  if (owner && currentChatOpening(chatId)) finishChatOpening(owner, outcome);
}

export function performanceHttpPhase(url: string, method?: string): HttpPhase | undefined {
  const path = new URL(url).pathname;
  if (method === "POST" || method === undefined) {
    if (path.endsWith("/api/auth/client-ticket")) return "client-ticket";
    if (path.endsWith("/api/auth/token")) return "client-token";
    if (method === "POST") return;
  }
  if (method !== undefined && method !== "GET") return;
  if (path.endsWith("/api/config")) return "config";
  if (path.endsWith("/api/chats")) return "chats";
  if (/\/api\/chats\/[^/]+\/snapshot$/.test(path)) return "chat-snapshot";
  if (/\/api\/chats\/[^/]+$/.test(path)) return "chat-summary";
  if (path.endsWith("/api/workspaces")) return "workspaces";
  if (path.endsWith("/api/automations")) return "automations";
  if (/\/api\/automations\/[^/]+\/runs$/.test(path)) return "automation-runs";
  if (path.endsWith("/api/execution-hosts")) return "execution-hosts";
  if (path.endsWith("/api/terminal-sessions")) return "terminals";
}

export async function measurePerformanceRequest(request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
  const phase = capture && performanceHttpPhase(request.url, request.method);
  const end = phase ? beginPerformanceSpan(phase) : undefined;
  if (!end) return send(request);
  try {
    const response = await send(request);
    end(response.ok ? "ok" : "error", response.status);
    return response;
  } catch (error) {
    end(performanceFailure(request.signal.aborted ? request.signal.reason : error));
    throw error;
  }
}

function collectResource(owner: Capture, entry: PerformanceResourceTiming): void {
  const navigation = entry.entryType === "navigation";
  const resource = navigation ? undefined : performanceHttpPhase(entry.name);
  if (!navigation && !resource && (!["script", "link", "css"].includes(entry.initiatorType)
    || new URL(entry.name).origin !== location.origin)) return;
  if (owner.origin !== 0 && entry.startTime < owner.origin) return;
  const sample = add(owner, navigation ? "navigation" : resource ?? "assets", entry.startTime, "resource-timing");
  const detailed = entry.requestStart > 0 && entry.responseStart >= entry.requestStart;
  if (entry.responseStatus > 0) sample.status = entry.responseStatus;
  sample.timing = {
    dnsMs: entry.domainLookupStart > 0 ? Math.round(entry.domainLookupEnd - entry.domainLookupStart) : null,
    connectMs: entry.connectStart > 0 ? Math.round(entry.connectEnd - entry.connectStart) : null,
    tlsMs: entry.secureConnectionStart > 0 ? Math.round(entry.connectEnd - entry.secureConnectionStart) : null,
    requestToFirstByteMs: detailed ? Math.round(entry.responseStart - entry.requestStart) : null,
    downloadMs: detailed ? Math.round(entry.responseEnd - entry.responseStart) : null,
    transferBytes: detailed || entry.transferSize > 0 ? entry.transferSize : null,
  };
  finish(sample, entry.responseEnd, entry.startTime, sample.status !== undefined && sample.status >= 400 ? "error" : "ok");
}

function startCapture(startup: boolean): void {
  const start = performance.now();
  const owner: Capture = {
    origin: startup ? 0 : start, samples: [], discarded: 0, foregroundCount: 0, visibilityEpoch: 0,
    hiddenAt: document.hidden ? start : undefined,
  };
  capture = owner;
  if (startup) {
    finish(add(owner, "frontend", 0, "client"), start, 0, "ok");
    owner.startup = add(owner, "startup-content", 0, "client");
  }
  const observer = typeof PerformanceObserver !== "undefined" ? new PerformanceObserver((list) => {
    if (capture !== owner) return;
    for (const entry of list.getEntries()) collectResource(owner, entry as PerformanceResourceTiming);
  }) : undefined;
  for (const type of ["navigation", "resource"]) {
    if (observer && PerformanceObserver.supportedEntryTypes?.includes(type)) observer.observe({ type, buffered: true });
  }
  owner.observer = observer;
}

function visibilityChanged(): void {
  const owner = capture;
  if (!owner) return;
  owner.visibilityEpoch++;
  if (document.hidden) {
    finishChatOpening(owner, "aborted");
    const foreground = owner.foreground;
    if (foreground) for (const sample of [foreground.visible, foreground.realtime, foreground.update]) {
      if (sample.outcome === "pending") sample.outcome = "unobserved";
    }
    owner.foreground = undefined;
    owner.hiddenAt = performance.now();
    scheduleNotification();
    return;
  }
  if (owner.hiddenAt === undefined) return;
  const start = performance.now();
  const sample = add(owner, "foreground", start, "client");
  const id = ++owner.foregroundCount;
  sample.foreground = id;
  sample.backgroundMs = Math.round(start - owner.hiddenAt);
  owner.hiddenAt = undefined;
  finish(sample, start, start, "ok");
  const visible = add(owner, "foreground-visible", start, "client");
  const realtime = add(owner, "foreground-realtime", start, "client");
  const update = add(owner, "foreground-update", start, "client");
  visible.foreground = realtime.foreground = update.foreground = id;
  owner.foreground = { id, start, socket: connection === "subscribed" ? socketId : -1, visible, realtime, update, snapshotObserved: false };
  notify();
}

export function initializePerformanceStats(clientMode: Mode | "external", clientVersion?: string): void {
  if (browserDocument || clientMode === "external") return;
  browserDocument = true;
  mode = clientMode;
  version = clientVersion;
  document.addEventListener("visibilitychange", visibilityChanged);
  const stored = readStorage(STORAGE_KEY);
  if (stored.ok && stored.value === "1") startCapture(true);
  else if (stored.ok && stored.value !== null && stored.value !== "0") warnStorageIssue(STORAGE_KEY, "invalid-value");
}

export function setPerformanceCapture(enabled: boolean): void {
  const result = writeStorage(STORAGE_KEY, enabled ? "1" : "0");
  if (!result.ok) throw result.error;
  if (enabled && !capture) startCapture(false);
  if (!enabled) {
    capture?.observer?.disconnect();
    capture = undefined;
  }
  panel = enabled;
  notify();
}

export function setPerformancePanel(open: boolean): void {
  panel = open && Boolean(capture);
  notify();
}

export function newPerformanceSocket(): number {
  setPerformanceConnection(++socketId, "connecting");
  return socketId;
}

export function setPerformanceConnection(id: number, state: Connection): void {
  if (id !== socketId) return;
  connection = state;
  scheduleNotification();
}

export function confirmPerformanceConnection(id: number, fromAcknowledgement: boolean): void {
  const owner = capture;
  const foreground = owner?.foreground;
  if (!foreground || foreground.realtime.outcome !== "pending" || id !== socketId
    || (id === foreground.socket && !fromAcknowledgement && connection !== "subscribed")) return;
  if (!fromAcknowledgement && id !== foreground.socket) return;
  foreground.realtime.connection = id === foreground.socket ? "reused" : "reconnected";
  finish(foreground.realtime, performance.now(), foreground.start, "ok");
}

export function notePerformanceContent(screen: Screen, changed: boolean): void {
  const owner = capture;
  if (!owner || document.hidden) return;
  const now = performance.now();
  if (owner.startup) {
    owner.startup.screen = screen;
    finish(owner.startup, now, 0, "ok");
    owner.startup = undefined;
  }
  const foreground = owner.foreground;
  if (!foreground) return;
  if (foreground.visible.outcome === "pending") {
    foreground.visible.screen = screen;
    finish(foreground.visible, now, foreground.start, "ok");
  }
  if (changed && foreground.update.outcome === "pending") {
    foreground.update.screen = screen;
    finish(foreground.update, now, foreground.start, "ok");
  }
}

export function notePerformanceChatSnapshot(changed: boolean, started: number): void {
  const owner = capture;
  const foreground = owner?.foreground;
  if (!owner || !foreground || foreground.snapshotObserved || started < foreground.start) return;
  foreground.snapshotObserved = true;
  finish(add(owner, "foreground-chat-snapshot", foreground.start, "client"), performance.now(), foreground.start,
    changed ? "ok" : "unchanged");
}

export function getPerformanceStats() {
  return { enabled: Boolean(capture), panel, connection, samples: capture?.samples ?? [], discarded: capture?.discarded ?? 0 };
}

export function exportPerformanceStats(appVersion?: string): string {
  const owner = capture;
  if (!owner) throw new Error("Performance capture is not enabled.");
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return JSON.stringify({
    schemaVersion: 1,
    client: { version: version ?? appVersion ?? null, mode, surface: window.webappNativeResourceSaver ? "native-webview" : "browser" },
    capture: { startedAt: owner.origin === 0 ? "navigation" : "manual",
      navigationType: navigation?.type ?? null, discarded: owner.discarded },
    samples: owner.samples.toSorted((a, b) => a.startMs - b.startMs),
  }, null, 2);
}
