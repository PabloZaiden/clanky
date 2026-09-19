/**
 * Compatibility facade for transcript persistence callers.
 *
 * New code should depend on the focused resource stores or the shared SQL
 * contract. This module forwards the legacy generic exports during migration
 * without owning transcript logic.
 */
export * from "./sql-store";
export { TranscriptCursorError } from "./cursor";
export { getTranscriptStateEntries } from "./projection";
export type {
  TranscriptCursor,
  TranscriptEntriesPage,
  TranscriptEntryKind,
  TranscriptMeta,
  TranscriptResource,
  TranscriptResponseRow,
  TranscriptRow,
  TranscriptStateEntry,
  TranscriptStateLike,
  TranscriptTableConfig,
} from "./types";
