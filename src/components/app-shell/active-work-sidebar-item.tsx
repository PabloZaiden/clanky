import { useSyncExternalStore } from "react";
import {
  Badge,
  formatStatusLabel,
  type SidebarNode,
} from "@pablozaiden/webapp/web";
import { formatSidebarRelativeTime } from "../../utils";

export type ActiveWorkSidebarItemType = "Task" | "Chat" | "Terminal";

const ACTIVE_WORK_CLOCK_INTERVAL_MS = 60_000;
const activeWorkClockSubscribers = new Set<() => void>();
let activeWorkClockTimer: ReturnType<typeof setTimeout> | null = null;
let activeWorkClockSnapshot = Date.now();

function getActiveWorkClockSnapshot(): number {
  return activeWorkClockSnapshot;
}

function scheduleActiveWorkClockTick(): void {
  if (activeWorkClockTimer !== null || activeWorkClockSubscribers.size === 0) {
    return;
  }

  const delayMs = ACTIVE_WORK_CLOCK_INTERVAL_MS
    - (Date.now() % ACTIVE_WORK_CLOCK_INTERVAL_MS);
  activeWorkClockTimer = setTimeout(() => {
    activeWorkClockTimer = null;
    activeWorkClockSnapshot = Date.now();
    [...activeWorkClockSubscribers].forEach((listener) => listener());
    scheduleActiveWorkClockTick();
  }, delayMs);
}

// Keep one timer for all visible Active work rows.
function subscribeToActiveWorkClock(listener: () => void): () => void {
  activeWorkClockSubscribers.add(listener);
  if (activeWorkClockSubscribers.size === 1) {
    activeWorkClockSnapshot = Date.now();
  }
  scheduleActiveWorkClockTick();

  return () => {
    activeWorkClockSubscribers.delete(listener);
    if (activeWorkClockSubscribers.size === 0 && activeWorkClockTimer !== null) {
      clearTimeout(activeWorkClockTimer);
      activeWorkClockTimer = null;
    }
  };
}

export function ActiveWorkSidebarItem({
  node,
  itemType,
  lastInteractionAt,
}: {
  node: SidebarNode;
  itemType: ActiveWorkSidebarItemType;
  lastInteractionAt: string;
}) {
  const nowMs = useSyncExternalStore(
    subscribeToActiveWorkClock,
    getActiveWorkClockSnapshot,
    getActiveWorkClockSnapshot,
  );
  const relativeTime = formatSidebarRelativeTime(lastInteractionAt, nowMs);
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
  const isTextBadge = node.badgeAppearance === "text";

  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
        <span className="clanky-sidebar-item-metadata">
          {relativeTime ? (
            <small className="clanky-sidebar-item-age">{relativeTime}</small>
          ) : null}
          <small className="clanky-sidebar-item-type">{itemType}</small>
        </span>
      </span>
      {node.badge ? (
        <Badge
          variant={node.badgeVariant}
          appearance={isTextBadge ? "text" : "pill"}
          className={[
            "wapp-sidebar-badge",
            isTextBadge ? "wapp-sidebar-badge-text" : "",
          ].filter(Boolean).join(" ")}
          title={badgeLabel}
          aria-label={badgeLabel}
        >
          {isTextBadge ? badgeLabel : " "}
        </Badge>
      ) : null}
    </>
  );
}
