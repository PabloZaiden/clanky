import type { Task } from "@/shared";

export interface TaskSummaryProps {
  /** The task to display */
  task: Task;
  /** Callback when the component is clicked */
  onClick?: () => void;
  /** Whether the full summary container should be visually obscured and non-clickable */
  privateHidden?: boolean;
}
