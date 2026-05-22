/**
 * Standalone utility helpers for TaskEngine.
 * These have no dependency on the TaskEngine class itself.
 */

import { createLogger } from "../logger";

const log = createLogger("core:engine");

/**
 * Stop pattern detector.
 * Checks if the AI response indicates completion.
 */
export class StopPatternDetector {
  private pattern: RegExp | null;

  constructor(patternString: string) {
    try {
      this.pattern = new RegExp(patternString);
    } catch (error) {
      // Invalid regex pattern — log a warning and disable matching
      // to prevent ReDoS or runtime crashes from user-supplied patterns.
      this.pattern = null;
      log.warn("Invalid stop pattern regex, disabling stop-pattern matching", {
        patternString,
        error: String(error),
      });
    }
  }

  /**
   * Check if the content matches the stop pattern.
   * Returns false if the pattern was invalid.
   */
  matches(content: string): boolean {
    if (!this.pattern) {
      return false;
    }
    return this.pattern.test(content);
  }
}

/**
 * Wraps an event stream's next() call with a timeout.
 * Throws an error if no event is received within the specified time.
 */
export async function nextWithTimeout<T>(
  stream: { next: () => Promise<T | null> },
  timeoutMs: number
): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`No activity for ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([stream.next(), timeoutPromise]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
