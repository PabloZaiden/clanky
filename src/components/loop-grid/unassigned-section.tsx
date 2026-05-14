import type { Loop } from "../../types";
import type { StatusGroups } from "../../hooks/useLoopGrouping";
import type { DashboardViewMode } from "../../types/preferences";
import { StatusSections } from "./status-sections";

export interface UnassignedSectionProps {
  unassignedLoops: Loop[];
  unassignedStatusGroups: StatusGroups;
  viewMode: DashboardViewMode;
  onEditDraft: (loopId: string) => void;
  onSelectLoop?: (loopId: string) => void;
}

/** Renders the fallback loop section for loops without a workspace or with a missing workspace. */
export function UnassignedSection({
  unassignedLoops,
  unassignedStatusGroups,
  viewMode,
  onEditDraft,
  onSelectLoop,
}: UnassignedSectionProps) {
  if (unassignedLoops.length === 0) return null;

  return (
    <div className="mb-10">
      <div className="flex items-center gap-3 mb-4 pb-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            Unassigned
          </h2>
        </div>
        <span className="text-sm text-gray-400 dark:text-gray-500">
          ({unassignedLoops.length} {unassignedLoops.length === 1 ? "loop" : "loops"})
        </span>
      </div>
      <p className="mb-4 pl-2 text-sm text-gray-500 dark:text-gray-400">
        Loops appear here when they are not assigned to a workspace or when their saved workspace is no longer available.
      </p>
      <div className="space-y-6 pl-2">
        <StatusSections
          statusGroups={unassignedStatusGroups}
          keyPrefix="unassigned"
          viewMode={viewMode}
          onEditDraft={onEditDraft}
          onSelectLoop={onSelectLoop}
        />
      </div>
    </div>
  );
}
