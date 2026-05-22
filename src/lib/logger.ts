/**
 * Frontend logger using tslog for browser environment.
 * 
 * This module provides a unified logging interface for the frontend that mirrors
 * the backend logger API. It uses tslog which supports both Node.js and Browser.
 * 
 * Log levels (from most to least verbose):
 * - silly (0): Very verbose debugging
 * - trace (1): Detailed trace information
 * - debug (2): Debug messages
 * - info (3): Informational messages (DEFAULT)
 * - warn (4): Warning messages
 * - error (5): Error messages
 * - fatal (6): Fatal error messages
 * 
 * Usage:
 * ```typescript
 * import { log, createLogger } from "../lib/logger";
 * 
 * // Use the main logger
 * log.info("Application started");
 * log.debug("Debug info", { data: someData });
 * 
 * // Create a component-specific logger
 * const componentLog = createLogger("MyComponent");
 * componentLog.info("Component initialized");
 * ```
 */

import { Logger, type ILogObj } from "tslog";
import {
  type LogLevelName,
  LOG_LEVELS,
  LOG_LEVEL_NAMES,
  DEFAULT_LOG_LEVEL,
} from "../utils/log-levels";

// Re-export shared constants so existing consumers don't need to change their imports
export { type LogLevelName, LOG_LEVELS, LOG_LEVEL_NAMES, DEFAULT_LOG_LEVEL };

/**
 * The frontend logger instance.
 * Configured for browser environment with pretty output.
 */
export const log: Logger<ILogObj> = new Logger({
  name: "clanky-ui",
  minLevel: LOG_LEVELS[DEFAULT_LOG_LEVEL],
  type: "pretty",
  // Browser-specific settings
  prettyLogTemplate: "{{yyyy}}-{{mm}}-{{dd}} {{hh}}:{{MM}}:{{ss}}\t{{logLevelName}}\t{{name}}\t",
  prettyLogTimeZone: "local",
  stylePrettyLogs: true,
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
 * Useful for component-specific logging.
 * 
 * Sub-loggers are cached by name - calling createLogger with the same name
 * returns the same instance. This prevents memory leaks from repeated calls
 * (e.g., during HMR or if called in render paths).
 * 
 * The sub-logger is registered so that its log level can be synchronized
 * when setLogLevel() is called (tslog sub-loggers don't automatically
 * inherit level changes from the parent).
 * 
 * @param name - The name for the sub-logger (e.g., "Dashboard", "CreateTaskForm")
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
 * List of all available log levels with descriptions.
 * Useful for UI dropdowns.
 */
export const LOG_LEVEL_OPTIONS: Array<{ value: LogLevelName; label: string; description: string }> = [
  { value: "silly", label: "Silly", description: "Very verbose debugging" },
  { value: "trace", label: "Trace", description: "Detailed trace information" },
  { value: "debug", label: "Debug", description: "Debug messages" },
  { value: "info", label: "Info", description: "Informational messages" },
  { value: "warn", label: "Warn", description: "Warning messages" },
  { value: "error", label: "Error", description: "Error messages" },
  { value: "fatal", label: "Fatal", description: "Fatal error messages" },
];
