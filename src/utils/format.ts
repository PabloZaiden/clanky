/**
 * Shared formatting utilities for the Clanky Tasks Management System.
 */

/**
 * Format a relative time string from an ISO 8601 date string.
 * Returns human-readable strings like "Just now", "5m ago", "2h ago", "3d ago".
 */
export function formatRelativeTime(isoString: string | undefined): string {
  if (!isoString) return "Never";

  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}
