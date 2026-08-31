/**
 * Shared presentation helpers for terminal connection modes.
 */

import type { TerminalConnectionMode, TerminalSessionState } from "@/shared";

export interface TerminalConnectionModeSessionLike {
  config: {
    connectionMode: TerminalConnectionMode;
  };
  state?: Pick<TerminalSessionState, "runtimeConnectionMode">;
}

export function getTerminalConnectionModeLabel(mode: TerminalConnectionMode): string {
  return mode === "direct" ? "Direct" : "Persistent";
}

export function getEffectiveTerminalConnectionMode(
  session: TerminalConnectionModeSessionLike,
): TerminalConnectionMode {
  return session.state?.runtimeConnectionMode ?? session.config.connectionMode;
}

export function isPersistentTerminalConnectionMode(mode: TerminalConnectionMode): boolean {
  return mode !== "direct";
}

export function isPersistentTerminalSession(session: TerminalConnectionModeSessionLike): boolean {
  return isPersistentTerminalConnectionMode(getEffectiveTerminalConnectionMode(session));
}
