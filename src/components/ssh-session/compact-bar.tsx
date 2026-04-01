import type { ReactNode } from "react";

export interface CompactBarProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  summary: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}

export function CompactBar({
  title,
  expanded,
  onToggle,
  summary,
  children,
  contentClassName = "",
}: CompactBarProps) {
  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-neutral-800">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-neutral-700/50">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 dark:focus:ring-gray-400 dark:focus:ring-offset-neutral-800"
          aria-expanded={expanded}
        >
          <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">{expanded ? "▼" : "▶"}</span>
          <span className="shrink-0 text-xs font-semibold text-gray-900 dark:text-gray-100">{title}</span>
        </button>
        <div className="min-w-0 flex-1">{summary}</div>
      </div>
      {expanded && (
        <div className={`border-t border-gray-200 px-3 py-2 dark:border-gray-700 ${contentClassName}`.trim()}>
          {children}
        </div>
      )}
    </div>
  );
}
