/**
 * Resource-fixed transcript adapters over the shared SQL implementation.
 *
 * Callers select chat, task, or agent-run at this boundary so SQL remains
 * shared without making resource identifiers part of higher-level contracts.
 */
import type { Database } from "bun:sqlite";
import type {
  ChatTranscriptStorageEntry,
  TaskLogEntry,
  ToolCallRecord,
  TranscriptChangeSet,
} from "@/shared";
import {
  applyTranscriptChangeSetInTransaction,
  getTranscriptMeta,
  getTranscriptMetaForUser,
  getTranscriptToolCall,
  getTranscriptToolCallForUser,
  hydrateTranscriptState,
  hydrateTranscriptStateForUser,
  listTranscriptEntries,
  listTranscriptEntriesForUser,
  listTranscriptEntriesPage,
  listTranscriptEntriesPageForUser,
  replaceTranscriptEntries,
  replaceTranscriptEntriesForUser,
  replaceTranscriptEntriesForUserInTransaction,
  syncTranscriptEntries,
  syncTranscriptEntriesInTransaction,
} from "./sql-store";
import type {
  TranscriptEntriesPage,
  TranscriptMeta,
  TranscriptPageOptions,
  TranscriptResource,
  TranscriptStateLike,
} from "./types";

export interface TranscriptResourceStore {
  readonly resource: TranscriptResource;
  getMetaForUser(resourceId: string, userId: string): TranscriptMeta | null;
  getMeta(resourceId: string): TranscriptMeta | null;
  replaceForUserInTransaction(
    db: Database,
    resourceId: string,
    userId: string,
    state: TranscriptStateLike,
    shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
  ): void;
  replaceForUser(
    resourceId: string,
    userId: string,
    state: TranscriptStateLike,
    shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
  ): void;
  replace(
    resourceId: string,
    state: TranscriptStateLike,
    shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
  ): void;
  syncInTransaction(
    db: Database,
    resourceId: string,
    userId: string,
    previousState: TranscriptStateLike,
    nextState: TranscriptStateLike,
    shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
  ): void;
  sync(
    resourceId: string,
    previousState: TranscriptStateLike,
    nextState: TranscriptStateLike,
    shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
  ): void;
  applyChangeSetInTransaction(
    db: Database,
    resourceId: string,
    userId: string,
    changes: TranscriptChangeSet,
  ): void;
  listForUser(
    resourceId: string,
    userId: string,
    includeToolPayload?: boolean,
  ): ChatTranscriptStorageEntry[];
  list(
    resourceId: string,
    includeToolPayload?: boolean,
  ): ChatTranscriptStorageEntry[];
  listPageForUser(
    resourceId: string,
    userId: string,
    options?: TranscriptPageOptions,
  ): TranscriptEntriesPage;
  listPage(
    resourceId: string,
    options?: TranscriptPageOptions,
  ): TranscriptEntriesPage;
  getToolCallForUser(
    resourceId: string,
    userId: string,
    toolCallId: string,
  ): ToolCallRecord | null;
  getToolCall(resourceId: string, toolCallId: string): ToolCallRecord | null;
  hydrateForUser(resourceId: string, userId: string): TranscriptStateLike;
  hydrate(resourceId: string): TranscriptStateLike;
}

export function createTranscriptResourceStore(
  resource: TranscriptResource,
): TranscriptResourceStore {
  return {
    resource,
    getMetaForUser: (resourceId, userId) =>
      getTranscriptMetaForUser(resource, resourceId, userId),
    getMeta: (resourceId) => getTranscriptMeta(resource, resourceId),
    replaceForUserInTransaction: (
      db,
      resourceId,
      userId,
      state,
      shouldIncludeLog,
    ) => replaceTranscriptEntriesForUserInTransaction(
      db,
      resource,
      resourceId,
      userId,
      state,
      shouldIncludeLog,
    ),
    replaceForUser: (resourceId, userId, state, shouldIncludeLog) =>
      replaceTranscriptEntriesForUser(
        resource,
        resourceId,
        userId,
        state,
        shouldIncludeLog,
      ),
    replace: (resourceId, state, shouldIncludeLog) =>
      replaceTranscriptEntries(resource, resourceId, state, shouldIncludeLog),
    syncInTransaction: (
      db,
      resourceId,
      userId,
      previousState,
      nextState,
      shouldIncludeLog,
    ) => syncTranscriptEntriesInTransaction(
      db,
      resource,
      resourceId,
      userId,
      previousState,
      nextState,
      shouldIncludeLog,
    ),
    sync: (resourceId, previousState, nextState, shouldIncludeLog) =>
      syncTranscriptEntries(
        resource,
        resourceId,
        previousState,
        nextState,
        shouldIncludeLog,
      ),
    applyChangeSetInTransaction: (db, resourceId, userId, changes) =>
      applyTranscriptChangeSetInTransaction(
        db,
        resource,
        resourceId,
        userId,
        changes,
      ),
    listForUser: (resourceId, userId, includeToolPayload) =>
      listTranscriptEntriesForUser(
        resource,
        resourceId,
        userId,
        includeToolPayload,
      ),
    list: (resourceId, includeToolPayload) =>
      listTranscriptEntries(resource, resourceId, includeToolPayload),
    listPageForUser: (resourceId, userId, options) =>
      listTranscriptEntriesPageForUser(
        resource,
        resourceId,
        userId,
        options,
      ),
    listPage: (resourceId, options) =>
      listTranscriptEntriesPage(resource, resourceId, options),
    getToolCallForUser: (resourceId, userId, toolCallId) =>
      getTranscriptToolCallForUser(
        resource,
        resourceId,
        userId,
        toolCallId,
      ),
    getToolCall: (resourceId, toolCallId) =>
      getTranscriptToolCall(resource, resourceId, toolCallId),
    hydrateForUser: (resourceId, userId) =>
      hydrateTranscriptStateForUser(resource, resourceId, userId),
    hydrate: (resourceId) => hydrateTranscriptState(resource, resourceId),
  };
}
