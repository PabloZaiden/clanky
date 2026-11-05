import { z } from "zod";
import { clientStorageKey } from "./client-credentials";
import { readStorage, warnStorageIssue, writeStorage } from "./storage";

declare global {
  interface Window {
    clankySessionDiagnosticsEnabled?: boolean;
  }
}

const eventSchema = z.object({
  at: z.number().finite(),
  event: z.enum([
    "restored", "credentials-missing", "restore-failed",
    "refresh-started", "refresh-succeeded", "refresh-failed",
    "credentials-removed", "signed-in", "signed-out", "server-changed",
    "foreground", "background", "online", "offline",
  ]),
  visibility: z.enum(["visible", "hidden"]),
  online: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  reason: z.enum(["authorization-rejected", "session-changed", "request-error", "storage-error", "unexpected-error"]).optional(),
}).strict();
const historySchema = z.array(eventSchema).max(10);
type SessionDiagnosticEvent = z.infer<typeof eventSchema>;

export interface ClientSessionDiagnostics {
  events: SessionDiagnosticEvent[];
  error?: Error;
}

let started = false;

export function clientSessionDiagnosticsEnabled(): boolean {
  return typeof window !== "undefined" && window.clankySessionDiagnosticsEnabled === true;
}

export function readClientSessionDiagnostics(): ClientSessionDiagnostics {
  if (!clientSessionDiagnosticsEnabled()) return { events: [] };
  const key = clientStorageKey("session-diagnostics");
  const result = readStorage(key);
  if (!result.ok) return { events: [], error: result.error };
  if (result.value === null) return { events: [] };
  try {
    const events: unknown = JSON.parse(result.value);
    const parsed = historySchema.safeParse(events);
    if (parsed.success) return { events: parsed.data };
  } catch {
    // Never include malformed persisted content in the diagnostic or its error.
  }
  warnStorageIssue(key, "invalid-value");
  return { events: [], error: new Error("Saved session diagnostics are invalid.") };
}

export function recordClientSessionDiagnostic(
  event: SessionDiagnosticEvent["event"],
  details: Pick<SessionDiagnosticEvent, "status" | "reason"> = {},
): void {
  if (!clientSessionDiagnosticsEnabled()) return;
  const previous = readClientSessionDiagnostics();
  const entry = eventSchema.parse({
    at: Date.now(), event,
    visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
    online: navigator.onLine,
    ...details,
  });
  const history = [...previous.events, entry];
  const removal = history.findLast(item => item.event === "credentials-removed");
  let events = history.slice(-10);
  // Keep the sign-out cause available despite later connectivity/lifecycle churn.
  if (removal && !history.slice(history.indexOf(removal) + 1).some(item =>
    ["restored", "signed-in", "signed-out", "server-changed"].includes(item.event))
    && !events.includes(removal)) {
    events = [removal, ...events.slice(-9)];
  }
  writeStorage(clientStorageKey("session-diagnostics"), JSON.stringify(events));
}

export function startClientSessionDiagnostics(): void {
  if (!clientSessionDiagnosticsEnabled() || started) return;
  started = true;
  document.addEventListener("visibilitychange", () => {
    recordClientSessionDiagnostic(document.visibilityState === "hidden" ? "background" : "foreground");
  });
  window.addEventListener("online", () => { recordClientSessionDiagnostic("online"); });
  window.addEventListener("offline", () => { recordClientSessionDiagnostic("offline"); });
}
