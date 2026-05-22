/**
 * Shared component props types for Clanky Tasks Management System.
 *
 * Types in this module are shared between multiple UI components
 * (e.g., TaskCard, TaskRow) to avoid coupling one component's
 * implementation to another. They are the single source of truth
 * for shared component prop shapes.
 *
 * @module types/components
 */

import type { Task } from "./task";

/**
 * Shared props for task summary display components (TaskCard, TaskRow).
 * Both components render a task summary with identical action callbacks.
 */
export interface TaskSummaryProps {
  /** The task to display */
  task: Task;
  /** Callback when the component is clicked */
  onClick?: () => void;
}
