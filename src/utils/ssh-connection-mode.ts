/**
 * Shared presentation helpers for SSH connection modes.
 */

import type { SshConnectionMode, SshSessionState } from "@/shared";

export interface SshConnectionModeSessionLike {
  config: {
    connectionMode: SshConnectionMode;
  };
  state?: Pick<SshSessionState, "runtimeConnectionMode">;
}

export function getSshConnectionModeLabel(mode: SshConnectionMode): string {
  return mode === "direct" ? "Direct SSH" : "Persistent SSH";
}

export function getEffectiveSshConnectionMode(session: SshConnectionModeSessionLike): SshConnectionMode {
  return session.state?.runtimeConnectionMode ?? session.config.connectionMode;
}

export function isPersistentSshConnectionMode(mode: SshConnectionMode): boolean {
  return mode !== "direct";
}

export function isPersistentSshSession(session: SshConnectionModeSessionLike): boolean {
  return isPersistentSshConnectionMode(getEffectiveSshConnectionMode(session));
}
