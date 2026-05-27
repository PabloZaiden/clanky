import { useId, type MouseEvent, type ReactNode } from "react";
import { StatusBadge, type BadgeVariant } from "../common";

const TREE_INDENT_REM = 0.375;
const TREE_ITEM_GUTTER_WIDTH_CLASS = "w-3";
const SECTION_ACTION_SLOT_CLASS = "flex min-w-12 shrink-0 justify-end";
const SECTION_ACTION_BUTTON_CLASS =
  "inline-flex min-w-[2.75rem] items-center justify-center rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 transition hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100";

function getIndentStyle(indentLevel: number): { marginLeft: string } | undefined {
  if (indentLevel <= 0) {
    return undefined;
  }

  return {
    marginLeft: `${indentLevel * TREE_INDENT_REM}rem`,
  };
}

function SectionAction({
  title,
  actionLabel,
  actionTitle,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  actionTitle?: string;
  onAction?: () => void;
}) {
  if (!onAction || !actionLabel) {
    return null;
  }

  return (
    <div className={SECTION_ACTION_SLOT_CLASS}>
      <button
        type="button"
        onClick={onAction}
        aria-label={`${actionLabel} ${title}`}
        title={actionTitle}
        className={SECTION_ACTION_BUTTON_CLASS}
      >
        {actionLabel}
      </button>
    </div>
  );
}

export function ShellSection({
  title,
  actionLabel,
  actionTitle,
  onAction,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  actionLabel?: string;
  actionTitle?: string;
  onAction?: () => void;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const contentId = useId();
  const toggleLabel = `${collapsed ? "Expand" : "Collapse"} ${title} section`;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
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
        <SectionAction title={title} actionLabel={actionLabel} actionTitle={actionTitle} onAction={onAction} />
      </div>
      {!collapsed && (
        <div id={contentId} className="space-y-1">
          {children}
        </div>
      )}
    </section>
  );
}

export function SidebarTreeSection({
  title,
  actionLabel,
  actionTitle,
  onAction,
  collapsed,
  onToggle,
  indentLevel = 0,
  children,
}: {
  title: string;
  actionLabel?: string;
  actionTitle?: string;
  onAction?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
  indentLevel?: number;
  children: ReactNode;
}) {
  const hasToggle = typeof onToggle === "function";
  const generatedContentId = useId();
  const contentId = hasToggle ? generatedContentId : undefined;
  const isCollapsed = collapsed ?? false;
  const toggleLabel = `${isCollapsed ? "Expand" : "Collapse"} ${title}`;
  const contentVisible = !hasToggle || !isCollapsed;
  const contentClassName =
    "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-gray-100 dark:hover:bg-neutral-800/60";

  return (
    <div className="space-y-1" style={getIndentStyle(indentLevel)}>
      <div className="flex items-center gap-2">
        {hasToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!isCollapsed}
            aria-controls={contentId}
            aria-label={toggleLabel}
            className={contentClassName}
          >
            <span className="text-[11px] text-gray-500 dark:text-gray-400">{isCollapsed ? "\u25B6" : "\u25BC"}</span>
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
              {title}
            </span>
          </button>
        ) : (
          <div className={contentClassName}>
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
              {title}
            </span>
          </div>
        )}
        <SectionAction title={title} actionLabel={actionLabel} actionTitle={actionTitle} onAction={onAction} />
      </div>
      {contentVisible && (
        <div id={contentId} className="space-y-1">
          {children}
        </div>
      )}
    </div>
  );
}

export function SidebarTreeItem({
  active = false,
  title,
  subtitle,
  badge,
  badgeVariant = "default",
  indentLevel = 0,
  onClick,
  onContextMenu,
  collapsed,
  onToggle,
}: {
  active?: boolean;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: BadgeVariant;
  indentLevel?: number;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const hasToggle = typeof onToggle === "function";

  return (
    <div className={hasToggle ? "flex items-stretch gap-1" : "flex items-stretch"} style={getIndentStyle(indentLevel)}>
      {hasToggle && (
        <div className={`${TREE_ITEM_GUTTER_WIDTH_CLASS} shrink-0`}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={collapsed === undefined ? undefined : !collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
            className="mt-1 -mx-1.5 inline-flex h-8 w-6 items-center justify-center rounded-lg text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
          >
            {collapsed ? "\u25B6" : "\u25BC"}
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={[
          "flex min-w-0 flex-1 items-center justify-between rounded-xl border py-2 pl-1 pr-3 text-left transition",
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
    </div>
  );
}

export function EmptySection({
  message,
  indentLevel = 0,
}: {
  message: string;
  indentLevel?: number;
}) {
  return (
    <div
      className="rounded-xl border border-dashed border-gray-300 px-3 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
      style={getIndentStyle(indentLevel)}
    >
      {message}
    </div>
  );
}
