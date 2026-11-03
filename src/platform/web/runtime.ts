import { DEFAULT_LOG_LEVEL, type LogLevelName } from "../contracts";
import type { WebAppClientRuntime, WebAppRuntimeSnapshot } from "@pablozaiden/webapp/web";
import { getClientSession, getClientStorageScope, subscribeClientSession } from "./client-session";

let identity: string | undefined;
let generation = 0;
let logLevel: LogLevelName = DEFAULT_LOG_LEVEL;
let snapshot: WebAppRuntimeSnapshot = { scope: "", generation, ready: true, logLevel };
const listeners = new Set<() => void>();

function synchronize(): void {
  const session = getClientSession();
  snapshot = {
    scope: session.enabled ? getClientStorageScope() : identity ? `user:${identity}` : "",
    generation: generation + session.generation,
    ready: !session.enabled || session.ready && session.authenticated,
    error: session.error,
    logLevel,
  };
  for (const listener of listeners) listener();
}

export function setClankyClientIdentity(next: string | undefined, level?: LogLevelName): void {
  if (identity !== next) {
    identity = next;
    generation++;
  }
  if (level !== undefined) logLevel = level;
  synchronize();
}

export const clankyClientRuntime: WebAppClientRuntime = {
  getSnapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    const unsubscribe = subscribeClientSession(synchronize);
    synchronize();
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  },
};
