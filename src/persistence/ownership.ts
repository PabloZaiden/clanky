import { requireCurrentUserId } from "../core/user-context";

export function requirePersistenceUserId(): string {
  return requireCurrentUserId();
}
