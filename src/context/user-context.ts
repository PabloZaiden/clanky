import { AsyncLocalStorage } from "node:async_hooks";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

const userContext = new AsyncLocalStorage<CurrentUser>();

export function runWithCurrentUser<T>(user: CurrentUser, callback: () => T): T {
  return userContext.run(user, callback);
}

export function getCurrentUser(): CurrentUser | undefined {
  return userContext.getStore();
}

export function requireCurrentUser(): CurrentUser {
  const user = getCurrentUser();
  if (!user) {
    throw new Error("Current user context is required");
  }
  return user;
}

export function getCurrentUserId(): string | undefined {
  return getCurrentUser()?.id;
}

export function requireCurrentUserId(): string {
  return requireCurrentUser().id;
}
