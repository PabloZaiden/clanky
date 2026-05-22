/**
 * Shared planning directory paths used by Clanky-managed task state files.
 */

import { posix as pathPosix } from "node:path";

export const PLANNING_DIRECTORY_NAME = ".clanky-planning";
export const PLAN_FILE_NAME = "plan.md";
export const STATUS_FILE_NAME = "status.md";
export const DEFAULT_PLAN_DISPLAY_PATH = pathPosix.join(PLANNING_DIRECTORY_NAME, PLAN_FILE_NAME);

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
