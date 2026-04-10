/**
 * Shared planning directory paths used by Ralpher-managed loop state files.
 */

export const PLANNING_DIRECTORY_NAME = ".ralph-planning";
export const PLAN_FILE_NAME = "plan.md";
export const STATUS_FILE_NAME = "status.md";

export function getPlanningDirectoryPath(directory: string): string {
  return `${directory}/${PLANNING_DIRECTORY_NAME}`;
}

export function getPlanFilePath(directory: string): string {
  return `${getPlanningDirectoryPath(directory)}/${PLAN_FILE_NAME}`;
}

export function getStatusFilePath(directory: string): string {
  return `${getPlanningDirectoryPath(directory)}/${STATUS_FILE_NAME}`;
}
