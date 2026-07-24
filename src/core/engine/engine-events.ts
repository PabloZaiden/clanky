/**
 * Log and persistence helpers for TaskEngine.
 */

import { log } from "@pablozaiden/webapp/server";
import type { LogLevel } from "@/shared/events";

export function logToConsole(
  level: LogLevel,
  taskPrefix: string,
  message: string,
  detailsStr: string,
  consoleLevel?: "trace" | "debug" | "info" | "warn" | "error",
): void {
  if (consoleLevel) {
    const levelTag = level === "agent" || level === "user" ? ` [${level}]` : "";
    const logMessage = `${taskPrefix}${levelTag} ${message}${detailsStr}`;
    switch (consoleLevel) {
      case "trace": log.trace(logMessage); break;
      case "debug": log.debug(logMessage); break;
      case "info": log.info(logMessage); break;
      case "warn": log.warn(logMessage); break;
      case "error": log.error(logMessage); break;
    }
  } else {
    switch (level) {
      case "error": log.error(`${taskPrefix} ${message}${detailsStr}`); break;
      case "warn": log.warn(`${taskPrefix} ${message}${detailsStr}`); break;
      case "info": log.info(`${taskPrefix} ${message}${detailsStr}`); break;
      case "debug": log.debug(`${taskPrefix} ${message}${detailsStr}`); break;
      case "trace": log.trace(`${taskPrefix} ${message}${detailsStr}`); break;
      case "agent":
      case "user":
        log.info(`${taskPrefix} [${level}] ${message}${detailsStr}`);
        break;
    }
  }
}
