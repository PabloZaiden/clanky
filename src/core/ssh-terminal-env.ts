/**
 * Shared terminal capability defaults for SSH sessions.
 */

export const DEFAULT_SSH_TERM = "xterm-256color";
export const DEFAULT_SSH_COLOR_TERM = "truecolor";

export function normalizeSshTerm(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "dumb" || trimmed === "unknown") {
    return DEFAULT_SSH_TERM;
  }
  return trimmed;
}
