import { useId } from "react";
import type { Loop } from "../../types";
import { StatusBadge, type BadgeVariant } from "../common";
import { getWorkspaceGroupCollapseKey } from "./shell-types";
import type { SidebarSectionId, WorkspaceSidebarGroup } from "./shell-types";

export function ShellSection({
  title,
  count,
  actionLabel,
  onAction,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  actionLabel?: string;
  onAction?: () => void;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const contentId = useId();
  const toggleLabel = `${collapsed ? "Expand" : "Collapse"} ${title} section`;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-controls={contentId}
              aria-label={toggleLabel}
              className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left transition hover:bg-gray-100 dark:hover:bg-neutral-800/60"
            >
              <span className="text-xs text-gray-500 dark:text-gray-400">{collapsed ? "\u25B6" : "\u25BC"}</span>
              <span className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                {title}
              </span>
            </button>
          </h2>
          {typeof count === "number" && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:bg-neutral-800 dark:text-gray-300">
              {count}
            </span>
          )}
        </div>
        {onAction && actionLabel && (
          <button
            type="button"
            onClick={onAction}
            className="rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
          >
            {actionLabel}
          </button>
        )}
      </div>
      {!collapsed && (
        <div id={contentId} className="space-y-1">
          {children}
        </div>
      )}
    </section>
  );
}

export interface SectionItemProps {
  active?: boolean;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: BadgeVariant;
  nested?: boolean;
  onClick: () => void;
}

export function SectionItem({
  active = false,
  title,
  subtitle,
  badge,
  badgeVariant = "default",
  nested = false,
  onClick,
}: SectionItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition",
        nested ? "ml-3 w-[calc(100%-0.75rem)]" : "",
        active
          ? "border-gray-900 bg-gray-900 text-white shadow-sm dark:border-gray-100 dark:bg-neutral-100 dark:text-gray-950"
          : "border-transparent bg-transparent text-gray-700 hover:border-gray-200 hover:bg-gray-100 dark:text-gray-200 dark:hover:border-gray-800 dark:hover:bg-neutral-800/80",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {subtitle && (
          <span
            className={[
              "mt-0.5 block truncate text-xs",
              active ? "text-gray-300 dark:text-gray-700" : "text-gray-500 dark:text-gray-400",
            ].join(" ")}
          >
            {subtitle}
          </span>
        )}
      </span>
      {badge && (
        <StatusBadge
          variant={badgeVariant}
          size="sm"
          className={[
            "ml-3 shrink-0",
            active ? "ring-1 ring-white/10 dark:ring-gray-300/20" : "",
          ].join(" ")}
        >
          {badge}
        </StatusBadge>
      )}
    </button>
  );
}

export function WorkspaceGroupedSectionItems({
  sectionId,
  groups,
  collapsedGroups,
  onToggleGroup,
  renderItem,
}: {
  sectionId: SidebarSectionId;
  groups: readonly WorkspaceSidebarGroup[];
  collapsedGroups: Partial<Record<string, boolean>>;
  onToggleGroup: (sectionId: SidebarSectionId, groupKey: string) => void;
  renderItem: (loop: Loop) => React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const collapseKey = getWorkspaceGroupCollapseKey(sectionId, group.key);
        const collapsed = collapsedGroups[collapseKey] ?? false;
        return (
          <div key={group.key} className="space-y-1">
            <button
              type="button"
              onClick={() => onToggleGroup(sectionId, group.key)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition hover:bg-gray-100 dark:hover:bg-neutral-800/60"
              aria-expanded={!collapsed}
            >
              <span className="text-[11px] text-gray-500 dark:text-gray-400">{collapsed ? "\u25B6" : "\u25BC"}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                {group.title}
              </span>
            </button>
            {!collapsed && (
              <div className="space-y-1">
                {group.items.map(renderItem)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function EmptySection({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 px-3 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
      {message}
    </div>
  );
}
