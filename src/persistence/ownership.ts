import { requireCurrentUserId } from "../core/user-context";

export const TEMPORARY_FRAMEWORK_OWNER_USER_ID = "admin";
export const TEMPORARY_FRAMEWORK_OWNER_USERNAME = "admin";

export function requirePersistenceUserId(): string {
  return requireCurrentUserId();
}
