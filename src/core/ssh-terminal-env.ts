/**
 * Shared terminal capability defaults for SSH sessions.
 */

export const DEFAULT_SSH_TERM = "xterm-256color";
export const DEFAULT_SSH_COLOR_TERM = "truecolor";
export const DEFAULT_SSH_TERM_PROGRAM = "Ghostty";
export const DEFAULT_SSH_TERM_PROGRAM_VERSION = "1.0.0-ralpher";
export const DEFAULT_SSH_UTF8_LOCALE = "C.UTF-8";

export function normalizeSshTerm(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "dumb" || trimmed === "unknown") {
    return DEFAULT_SSH_TERM;
  }
  return trimmed;
}

export function normalizeSshLocale(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "C" || trimmed === "POSIX") {
    return DEFAULT_SSH_UTF8_LOCALE;
  }
  return trimmed;
}
