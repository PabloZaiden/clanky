/**
 * Application-wide logger using tslog.
 * 
 * Log levels (in order from most to least verbose):
 * - silly (0): Very verbose debugging
 * - trace (1): Detailed trace information
 * - debug (2): Debug messages
 * - info (3): Informational messages (DEFAULT)
 * - warn (4): Warning messages
 * - error (5): Error messages
 * - fatal (6): Fatal error messages
 * 
 * Priority order for log level:
 * 1. CLANKY_LOG_LEVEL environment variable (highest priority)
 * 2. Saved preference in database (applied on startup)
 * 3. Default: "info" (level 3)
 * 
 * Valid values: silly, trace, debug, info, warn, error, fatal
 */

import { Logger, type ILogObj } from "tslog";
import {
  type LogLevelName,
  LOG_LEVELS,
  VALID_LOG_LEVELS,
  LOG_LEVEL_NAMES,
  DEFAULT_LOG_LEVEL,
} from "../utils/log-levels";

// Re-export shared constants so existing consumers don't need to change their imports
export { type LogLevelName, LOG_LEVELS, VALID_LOG_LEVELS, LOG_LEVEL_NAMES, DEFAULT_LOG_LEVEL };

/**
 * Get the initial log level from environment variable.
 * Returns the numeric log level if valid, or the default (info = 3).
 */
function getInitialLogLevel(): number {
  const envLevel = process.env["CLANKY_LOG_LEVEL"]?.toLowerCase();
  
  if (envLevel && envLevel in LOG_LEVELS) {
    return LOG_LEVELS[envLevel as LogLevelName];
  }
  
  // Default to info
  return LOG_LEVELS[DEFAULT_LOG_LEVEL];
}

/**
 * The application-wide logger instance.
 * Use this for all logging throughout the application.
 */
export const log: Logger<ILogObj> = new Logger({
  name: "clanky",
  minLevel: getInitialLogLevel(),
});

/**
 * Registry of all sub-loggers for level synchronization.
 * Using a Map keyed by name ensures:
 * 1. No duplicate loggers for the same name (prevents memory leaks from repeated calls)
 * 2. Efficient lookup when the same logger is requested multiple times
 * 3. All registered sub-loggers can be updated when setLogLevel() is called
 */
const subLoggers: Map<string, Logger<ILogObj>> = new Map();

/**
 * Create a child logger with a specific name.
 * Useful for module-specific logging.
 *
 * Sub-loggers are cached by name - calling createLogger with the same name
 * returns the same instance. The sub-logger is registered so that its log
 * level can be synchronized when setLogLevel() is called (tslog sub-loggers
 * don't automatically inherit level changes from the parent).
 *
 * @param name - The name for the sub-logger (e.g., "api:tasks", "core:engine")
 * @returns A Logger instance for the given name (cached)
 */
export function createLogger(name: string): Logger<ILogObj> {
  const existing = subLoggers.get(name);
  if (existing) {
    return existing;
  }

  const subLogger = log.getSubLogger({ name });
  subLoggers.set(name, subLogger);
  return subLogger;
}

/**
 * Set the log level at runtime.
 * Updates the logger's minLevel setting dynamically.
 * Also updates all registered sub-loggers to keep them in sync.
 * 
 * @param level - The log level name (silly, trace, debug, info, warn, error, fatal)
 */
export function setLogLevel(level: LogLevelName): void {
  if (!(level in LOG_LEVELS)) {
    throw new Error(`Invalid log level: ${level}. Valid levels are: ${Object.keys(LOG_LEVELS).join(", ")}`);
  }
  const numericLevel = LOG_LEVELS[level];

  // Update parent logger
  log.settings.minLevel = numericLevel;

  // Update all registered sub-loggers
  // (tslog sub-loggers copy the parent's minLevel at creation time
  // and don't automatically sync when the parent's level changes)
  for (const subLogger of subLoggers.values()) {
    subLogger.settings.minLevel = numericLevel;
  }
}

/**
 * Get the current log level name.
 * 
 * @returns The current log level name
 */
export function getLogLevel(): LogLevelName {
  const numericLevel = log.settings.minLevel;
  return LOG_LEVEL_NAMES[numericLevel] ?? DEFAULT_LOG_LEVEL;
}

/**
 * Check if the log level was set via environment variable.
 * Used to determine if the env var should take precedence over saved preferences.
 * 
 * @returns true if CLANKY_LOG_LEVEL environment variable is set
 */
export function isLogLevelFromEnv(): boolean {
  const envLevel = process.env["CLANKY_LOG_LEVEL"]?.toLowerCase();
  return envLevel !== undefined && envLevel in LOG_LEVELS;
}
