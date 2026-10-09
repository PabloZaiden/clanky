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

/**
 * Format an activity timestamp for the Active Work sidebar.
 * Returns null for invalid timestamps and clamps future timestamps to now.
 */
export function formatSidebarRelativeTime(
  isoString: string,
  nowMs: number = Date.now(),
): string | null {
  const timestampMs = Date.parse(isoString);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) {
    return null;
  }

  const seconds = Math.floor(Math.max(0, nowMs - timestampMs) / 1_000);
  if (seconds < 60) return "A few seconds ago";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "Last month" : `${months} months ago`;
  }

  const years = Math.floor(days / 365);
  return years === 1 ? "Last year" : `${years} years ago`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KB`;
  }
  return `${(kib / 1024).toFixed(1)} MB`;
}
