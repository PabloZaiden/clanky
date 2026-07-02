import type { Task } from "../../types";
import type { StatusGroups, StatusSectionKey } from "../../hooks/useTaskGrouping";
import type { DashboardViewMode } from "../../types/preferences";
import { sectionConfig } from "../../hooks/useTaskGrouping";
import { CollapsibleSection } from "../common";
import { TaskCard } from "../TaskCard";
import { TaskRow } from "../TaskRow";

interface TaskActions {
  onClick?: () => void;
}

export interface StatusSectionsProps {
  statusGroups: StatusGroups;
  keyPrefix: string;
  viewMode: DashboardViewMode;
  onEditDraft: (taskId: string) => void;
  onSelectTask?: (taskId: string) => void;
  isTaskPrivateHidden?: (task: Task) => boolean;
}

/** Renders collapsible status sections for a given set of grouped tasks */
export function StatusSections({
  statusGroups,
  keyPrefix,
  viewMode,
  onEditDraft,
  onSelectTask,
  isTaskPrivateHidden = () => false,
}: StatusSectionsProps) {
  function getTaskActions(sectionKey: StatusSectionKey, taskId: string): TaskActions {
    const actions: TaskActions = {};

    if (sectionKey === "draft") {
      actions.onClick = () => onEditDraft(taskId);
    } else if (onSelectTask) {
      actions.onClick = () => onSelectTask(taskId);
    }

    return actions;
  }

  return (
    <>
      {sectionConfig.map(({ key, label, defaultCollapsed }) => {
        const sectionTasks: Task[] = statusGroups[key];
        if (sectionTasks.length === 0) return null;

        return (
          <CollapsibleSection
            key={`${keyPrefix}-${key}`}
            title={label}
            count={sectionTasks.length}
            defaultCollapsed={defaultCollapsed}
            idPrefix={`${keyPrefix}-${key}`}
          >
            {viewMode === "rows" ? (
              <div className="flex flex-col gap-2">
                {sectionTasks.map((task) => (
                  <TaskRow
                    key={task.config.id}
                    task={task}
                    privateHidden={isTaskPrivateHidden(task)}
                    {...getTaskActions(key, task.config.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
                {sectionTasks.map((task) => (
                  <TaskCard
                    key={task.config.id}
                    task={task}
                    privateHidden={isTaskPrivateHidden(task)}
                    {...getTaskActions(key, task.config.id)}
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
