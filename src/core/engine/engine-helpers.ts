/**
 * Standalone utility helpers for TaskEngine.
 * These have no dependency on the TaskEngine class itself.
 */

import { createLogger } from "@pablozaiden/webapp/server";

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
