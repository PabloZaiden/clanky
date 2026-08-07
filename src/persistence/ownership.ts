import { requireCurrentUserId } from "../context/user-context";

export function requirePersistenceUserId(): string {
  return requireCurrentUserId();
}
