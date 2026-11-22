import { useId, useState, useSyncExternalStore } from "react";
import { Button, FormSection, SettingsFieldRow } from "@pablozaiden/webapp/web";
import { downloadGeneratedFile } from "./download-generated-file";
import {
  exportPerformanceStats, getPerformanceStats, performanceStatsRevision, setPerformanceCapture,
  setPerformancePanel, subscribePerformanceStats, summarizePerformanceRtt,
} from "./performance-stats";

function usePerformanceStats() {
  useSyncExternalStore(subscribePerformanceStats, performanceStatsRevision, () => 0);
  return getPerformanceStats();
}

function download(version?: string): void {
  const filename = `clanky-performance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  downloadGeneratedFile(new Blob([exportPerformanceStats(version)], { type: "application/json" }), filename);
}

export function PerformanceStatsSettings({ version }: { version?: string }) {
  const { enabled, panel } = usePerformanceStats();
  const captureId = useId();
  const [error, setError] = useState<string>();
  function run(action: () => void): void {
    setError(undefined);
    try { action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  return <FormSection title="Performance Stats">
    <SettingsFieldRow title="Capture performance" labelFor={captureId}
      content={<input id={captureId} type="checkbox" checked={enabled}
        onChange={(event) => run(() => setPerformanceCapture(event.currentTarget.checked))} />}
      actions={enabled ? <>
        <Button type="button" onClick={() => setPerformancePanel(!panel)}>{panel ? "Hide panel" : "Show panel"}</Button>
        <Button type="button" onClick={() => run(() => download(version))}>Export JSON</Button>
      </> : undefined} />
    {error ? <p className="wapp-error" role="alert">{error}</p> : null}
  </FormSection>;
}

function duration(value: number | null | undefined): string {
  if (value == null) return "Not measured";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value} ms`;
}

const connectionLabels = {
  idle: "Idle", connecting: "Connecting", open: "Open", subscribed: "Live", closed: "Disconnected",
} as const;

const chatOpenLabels = {
  pending: "Opening", aborted: "Canceled", timeout: "Timed out", error: "Failed",
  unchanged: "Not measured", unobserved: "Not measured",
} as const;

export function PerformanceStatsPanel({ version }: { version?: string }) {
  const { panel, connection, samples, discarded } = usePerformanceStats();
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string>();
  if (!panel) return null;
  const startup = samples.findLast((sample) => sample.phase === "startup-content");
  const chatOpen = samples.findLast((sample) => sample.phase === "chat-open");
  const foreground = samples.findLast((sample) => sample.phase === "foreground")?.foreground;
  const latest = (phase: string) => samples.findLast((sample) => sample.phase === phase && sample.foreground === foreground);
  const visible = latest("foreground-visible");
  const realtime = latest("foreground-realtime");
  const update = latest("foreground-update");
  const snapshot = latest("foreground-chat-snapshot");
  const { count, p50Ms, p95Ms } = summarizePerformanceRtt(samples);
  return (
    <aside aria-label="Performance Stats"
      className="fixed z-40 w-max overflow-y-auto rounded-lg border border-[var(--wapp-border-soft)] bg-[var(--wapp-surface-raised)] px-3 py-2 text-xs text-[var(--wapp-text)] shadow-lg"
      style={{
        top: "calc(0.5rem + max(3.5rem + var(--wapp-header-safe-area-top, var(--wapp-safe-area-top)), var(--wapp-header-min-height, 0px)))",
        right: "max(0.5rem, var(--wapp-safe-area-right))",
        maxWidth: "calc(100% - max(1rem, var(--wapp-safe-area-left)) - max(1rem, var(--wapp-safe-area-right)))",
        maxHeight: "calc(var(--wapp-viewport-height, 100vh) - 6rem - var(--wapp-safe-area-top) - var(--wapp-safe-area-bottom))",
      }}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>Performance Stats</strong>
        <span className="text-[var(--wapp-muted)]">{connectionLabels[connection]}</span>
        <Button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Minimize" : "Expand"}</Button>
        <Button type="button" onClick={() => setPerformancePanel(false)}>Hide</Button>
      </div>
      {expanded ? <>
        <dl className="my-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 tabular-nums">
          <dt>Startup to content</dt><dd>{duration(startup?.durationMs)}</dd>
          <dt>Chat open</dt><dd>{chatOpen && chatOpen.outcome !== "ok"
            ? chatOpenLabels[chatOpen.outcome] : duration(chatOpen?.durationMs)}</dd>
          <dt>Return to content</dt><dd>{duration(visible?.durationMs)}</dd>
          <dt>Socket confirmed</dt><dd>{realtime?.outcome === "ok" ? `${duration(realtime.durationMs)} (${realtime.connection})`
            : realtime?.outcome === "pending" ? "Awaiting confirmation" : "Not measured"}</dd>
          <dt>First update</dt><dd>{update?.outcome === "ok" ? duration(update.durationMs)
            : snapshot?.outcome === "unchanged" ? "No change in snapshot" : "Not observed"}</dd>
          <dt>WebSocket RTT</dt><dd>{duration(p50Ms)}{p50Ms !== null ? ` p50 (${count})` : ""}
            {p95Ms !== null ? ` / ${duration(p95Ms)} p95` : ""}</dd>
          <dt>Samples</dt><dd>{samples.length}{discarded > 0 ? ` (${discarded} discarded)` : ""}</dd>
        </dl>
        <Button type="button" onClick={() => {
          setError(undefined);
          try { download(version); }
          catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        }}>Export JSON</Button>
        {error ? <p className="wapp-error" role="alert">{error}</p> : null}
      </> : null}
    </aside>
  );
}
