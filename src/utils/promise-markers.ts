export type PromiseMarkerOutcomeKind = "plan_ready" | "complete" | "custom";

export interface PromiseMarkerMatch {
  marker: string;
  kind: PromiseMarkerOutcomeKind;
  label: string;
  content: string;
}

const TRAILING_PROMISE_MARKER_PATTERN = /^(?<content>[\s\S]*?)(?:\r?\n)?[ \t]*<promise>(?<marker>[^<]+)<\/promise>[ \t]*$/;

function humanizePromiseMarker(marker: string): string {
  return marker
    .trim()
    .toLowerCase()
    .split(/[_\s:-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPromiseMarkerOutcomeKind(marker: string): PromiseMarkerOutcomeKind {
  switch (marker.trim().toUpperCase()) {
    case "PLAN_READY":
      return "plan_ready";
    case "COMPLETE":
      return "complete";
    default:
      return "custom";
  }
}

function getPromiseMarkerLabel(marker: string, kind: PromiseMarkerOutcomeKind): string {
  switch (kind) {
    case "plan_ready":
      return "Plan ready";
    case "complete":
      return "Completed";
    case "custom":
      return humanizePromiseMarker(marker);
  }
}

export function detectTrailingPromiseMarker(content: string): PromiseMarkerMatch | null {
  const match = TRAILING_PROMISE_MARKER_PATTERN.exec(content);
  if (!match?.groups) {
    return null;
  }

  const marker = match.groups["marker"]?.trim();
  if (!marker) {
    return null;
  }

  const kind = getPromiseMarkerOutcomeKind(marker);
  return {
    marker,
    kind,
    label: getPromiseMarkerLabel(marker, kind),
    content: match.groups["content"]?.replace(/[ \t\r\n]+$/u, "") ?? "",
  };
}
