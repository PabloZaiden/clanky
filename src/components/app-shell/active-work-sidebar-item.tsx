import { useSyncExternalStore } from "react";
import {
  Badge,
  formatStatusLabel,
  type SidebarNode,
} from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { formatSidebarRelativeTime } from "../../utils";
import { ProviderIcon, WorkspaceIdentity } from "../common";

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

export function ActiveWorkMetadata({
  itemType,
  lastInteractionAt,
  workspace,
  className = "",
}: {
  itemType: ActiveWorkSidebarItemType;
  lastInteractionAt: string;
  workspace?: Workspace;
  className?: string;
}) {
  const nowMs = useSyncExternalStore(
    subscribeToActiveWorkClock,
    getActiveWorkClockSnapshot,
    getActiveWorkClockSnapshot,
  );
  const relativeTime = formatSidebarRelativeTime(lastInteractionAt, nowMs);

  return (
    <span className={`clanky-sidebar-item-metadata ${className}`.trim()}>
      {relativeTime ? (
        <small className="clanky-sidebar-item-age">{relativeTime}</small>
      ) : null}
      <span className="ml-auto inline-flex shrink-0 items-center gap-1">
        <small className="clanky-sidebar-item-type">{itemType}</small>
        {workspace ? (
          <ProviderIcon
            provider={workspace.serverSettings.agent.provider}
            size="h-3 w-4"
            className="opacity-80"
          />
        ) : null}
      </span>
    </span>
  );
}

export function ActiveWorkSidebarItem({
  node,
  itemType,
  lastInteractionAt,
  workspace,
}: {
  node: SidebarNode;
  itemType: ActiveWorkSidebarItemType;
  lastInteractionAt: string;
  workspace?: Workspace;
}) {
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
  const isTextBadge = node.badgeAppearance === "text";

  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {workspace ? (
          <WorkspaceIdentity
            workspace={workspace}
            iconSize="h-3.5 w-3.5"
            className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
            showProviderIcon={false}
          />
        ) : node.subtitle ? <small>{node.subtitle}</small> : null}
        <ActiveWorkMetadata
          itemType={itemType}
          lastInteractionAt={lastInteractionAt}
          workspace={workspace}
        />
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
