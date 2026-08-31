/**
 * Helper for generating human-readable standalone SSH server session names.
 */

export function buildDefaultSshServerSessionName(serverName: string, existingSessionCount: number): string {
  const normalizedServerName = serverName.trim() || "SSH Session";
  const normalizedCount = Math.max(0, Math.floor(existingSessionCount));
  return `${normalizedServerName} ${String(normalizedCount + 1)}`;
}
