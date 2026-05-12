import type { Loop } from "../../types";
import type { StatusGroups, StatusSectionKey } from "../../hooks/useLoopGrouping";
import type { DashboardViewMode } from "../../types/preferences";
import { sectionConfig } from "../../hooks/useLoopGrouping";
import { CollapsibleSection } from "../common";
import { LoopCard } from "../LoopCard";
import { LoopRow } from "../LoopRow";

interface LoopActions {
  onClick?: () => void;
}

export interface StatusSectionsProps {
  statusGroups: StatusGroups;
  keyPrefix: string;
  viewMode: DashboardViewMode;
  onEditDraft: (loopId: string) => void;
  onSelectLoop?: (loopId: string) => void;
}

/** Renders collapsible status sections for a given set of grouped loops */
export function StatusSections({
  statusGroups,
  keyPrefix,
  viewMode,
  onEditDraft,
  onSelectLoop,
}: StatusSectionsProps) {
  function getLoopActions(sectionKey: StatusSectionKey, loopId: string): LoopActions {
    const actions: LoopActions = {};

    if (sectionKey === "draft") {
      actions.onClick = () => onEditDraft(loopId);
    } else if (onSelectLoop) {
      actions.onClick = () => onSelectLoop(loopId);
    }

    return actions;
  }

  return (
    <>
      {sectionConfig.map(({ key, label, defaultCollapsed }) => {
        const sectionLoops: Loop[] = statusGroups[key];
        if (sectionLoops.length === 0) return null;

        return (
          <CollapsibleSection
            key={`${keyPrefix}-${key}`}
            title={label}
            count={sectionLoops.length}
            defaultCollapsed={defaultCollapsed}
            idPrefix={`${keyPrefix}-${key}`}
          >
            {viewMode === "rows" ? (
              <div className="flex flex-col gap-2">
                {sectionLoops.map((loop) => (
                  <LoopRow
                    key={loop.config.id}
                    loop={loop}
                    {...getLoopActions(key, loop.config.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
                {sectionLoops.map((loop) => (
                  <LoopCard
                    key={loop.config.id}
                    loop={loop}
                    {...getLoopActions(key, loop.config.id)}
                  />
                ))}
              </div>
            )}
          </CollapsibleSection>
        );
      })}
    </>
  );
}
