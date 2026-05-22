/**
 * Reusable collapsible section component for the dashboard.
 * Follows the same pattern as the collapsible sections in TaskDetails.tsx.
 */

import { useState, useId } from "react";
import type { ReactNode } from "react";

export interface CollapsibleSectionProps {
  /** Section title displayed in the header */
  title: string;
  /** Number of items in the section, displayed in parentheses */
  count: number;
  /** Whether the section should be collapsed by default */
  defaultCollapsed?: boolean;
  /** Optional prefix for the generated ID (for readability in DOM/tests) */
  idPrefix?: string;
  /** Section content (rendered when expanded) */
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  count,
  defaultCollapsed = false,
  idPrefix,
  children,
}: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const reactId = useId();

  // Combine the idPrefix (if provided) with React's unique ID for guaranteed uniqueness
  const sectionId = idPrefix ? `${idPrefix}-${reactId}` : reactId;

  return (
    <section>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="text-md font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2 hover:text-gray-900 dark:hover:text-gray-100 transition-colors text-left cursor-pointer"
        aria-expanded={!collapsed}
        aria-controls={sectionId}
      >
        <span className="text-xs">{collapsed ? "\u25B6" : "\u25BC"}</span>
        <span>{title} ({count})</span>
      </button>
      {!collapsed && (
        <div id={sectionId}>
          {children}
        </div>
      )}
    </section>
  );
}
