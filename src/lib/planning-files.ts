/**
 * Shared planning directory paths used by Ralpher-managed loop state files.
 */

import { posix as pathPosix } from "node:path";

export const PLANNING_DIRECTORY_NAME = ".ralph-planning";
export const PLAN_FILE_NAME = "plan.md";
export const STATUS_FILE_NAME = "status.md";

export function normalizePlanningBasePath(directory: string): string {
  return pathPosix.normalize(directory.replaceAll("\\", "/"));
}

export function getPlanningDirectoryPath(directory: string): string {
  return pathPosix.join(normalizePlanningBasePath(directory), PLANNING_DIRECTORY_NAME);
}

export function getPlanFilePath(directory: string): string {
  return pathPosix.join(getPlanningDirectoryPath(directory), PLAN_FILE_NAME);
}

export function getStatusFilePath(directory: string): string {
  return pathPosix.join(getPlanningDirectoryPath(directory), STATUS_FILE_NAME);
}
