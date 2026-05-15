/**
 * Loop persistence layer for Ralph Loops Management System.
 * Handles reading and writing loop data to SQLite database.
 *
 * Note: Exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage (e.g., remote database, async I/O) in the future.
 */

export {
  saveLoop,
  loadLoop,
  deleteLoop,
  listLoops,
  listLoopSummaries,
  createLoopListSnapshot,
  loopExists,
  updateLoopState,
  updateLoopConfig,
  getActiveLoopByDirectory,
  isStaleLoopStatus,
  resetStaleLoop,
  resetStaleLoops,
} from "./loops/index";
