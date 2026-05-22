/**
 * Workspace persistence layer for Clanky Tasks Management System.
 * Handles reading and writing workspace data to SQLite database.
 *
 * Note: Most exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

export * from "./workspaces/index";
