/**
 * Connection-scoped, owner-isolated cache of committed chat metadata.
 */
import type { Database } from "bun:sqlite";
import { channel } from "node:diagnostics_channel";
import type { Chat, ChatState, ChatStreamControlState } from "@/shared";
import type { PersistedChatStateField } from "./helpers";

const MAX_ENTRIES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const diagnostics = channel("clanky.chat-metadata-cache");

interface CacheEntry {
  userId: string;
  chat: Chat;
  bytes: number;
}

interface MetadataCache {
  entries: Map<string, CacheEntry>;
  bytes: number;
}

const caches = new WeakMap<Database, MetadataCache>();

function publish(operation: string, count = 1): void {
  if (diagnostics.hasSubscribers) diagnostics.publish({ operation, count });
}

function key(userId: string, chatId: string): string {
  return JSON.stringify([userId, chatId]);
}

function remove(cache: MetadataCache, entryKey: string): boolean {
  const entry = cache.entries.get(entryKey);
  if (!entry) return false;
  cache.entries.delete(entryKey);
  cache.bytes -= entry.bytes;
  return true;
}

export function cacheChatMetadata(db: Database, userId: string, chat: Chat): void {
  const metadata: Chat = {
    config: chat.config,
    state: { ...chat.state, messages: [], logs: [], toolCalls: [] },
  };
  storeMetadata(db, userId, { metadata, clone: true });
}

function storeMetadata(db: Database, userId: string, { metadata, clone }: {
  metadata: Chat; clone: boolean;
}): void {
  if (db.inTransaction) return;
  const bytes = Buffer.byteLength(JSON.stringify(metadata));
  const entryKey = key(userId, metadata.config.id);
  let cache = caches.get(db);
  if (cache) remove(cache, entryKey);
  if (bytes > MAX_ENTRY_BYTES) {
    publish("oversized");
    return;
  }
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    caches.set(db, cache);
  }
  while (cache.entries.size >= MAX_ENTRIES || cache.bytes + bytes > MAX_BYTES) {
    remove(cache, cache.entries.keys().next().value!);
    publish("evict");
  }
  cache.entries.set(entryKey, { userId, chat: clone ? structuredClone(metadata) : metadata, bytes });
  cache.bytes += bytes;
  publish("store");
}

function copyStateField<Field extends PersistedChatStateField>(
  target: ChatState,
  source: ChatState,
  field: Field,
): void {
  const value = source[field];
  target[field] = value !== null && typeof value === "object" ? structuredClone(value) : value;
}

export function beginChatMetadataWrite(
  db: Database,
  userId: string,
  chatId: string,
): (chat: Chat, previousRevision: number, fields: ReadonlySet<PersistedChatStateField>) => void {
  const previous = db.inTransaction ? undefined : caches.get(db)?.entries.get(key(userId, chatId))?.chat;
  invalidateChatMetadata(db, userId, chatId);
  return (chat, previousRevision, fields) => {
    if (chat.config.id !== chatId) throw new Error("Chat metadata write returned a different chat");
    if (db.inTransaction) return;
    if (!previous || previous.state.revision !== previousRevision) {
      cacheChatMetadata(db, userId, chat);
      return;
    }
    // Reuse only private unchanged branches; callers retain independent values.
    const state: ChatState = {
      ...previous.state,
      revision: chat.state.revision,
      hasMessages: chat.state.hasMessages,
      hasTranscript: chat.state.hasTranscript,
      lastUserMessageAt: chat.state.lastUserMessageAt,
    };
    for (const field of fields) copyStateField(state, chat.state, field);
    storeMetadata(db, userId, { metadata: { config: previous.config, state }, clone: false });
  };
}

function readMetadata(
  db: Database,
  userId: string,
  chatId: string,
  load: () => Chat | null,
): Chat | null {
  // Synchronous fills cannot race a writer; transaction-local rows must never
  // enter the cache, even if an enclosing transaction later rolls back.
  if (db.inTransaction) {
    publish("transaction");
    return load();
  }
  const cache = caches.get(db);
  const entryKey = key(userId, chatId);
  const entry = cache?.entries.get(entryKey);
  if (entry && cache) {
    cache.entries.delete(entryKey);
    cache.entries.set(entryKey, entry);
    publish("hit");
    return entry.chat;
  }
  publish("miss");
  const chat = load();
  if (chat) cacheChatMetadata(db, userId, chat);
  return chat;
}

export function readChatMetadata(
  db: Database,
  userId: string,
  chatId: string,
  load: () => Chat | null,
): Chat | null {
  const chat = readMetadata(db, userId, chatId, load);
  return chat ? structuredClone(chat) : null;
}

export function readChatStreamControlState(
  db: Database,
  userId: string,
  chatId: string,
  load: () => Chat | null,
): ChatStreamControlState | null {
  const chat = readMetadata(db, userId, chatId, load);
  if (!chat) return null;
  const binding = chat.state.session?.binding;
  return {
    status: chat.state.status,
    interruptRequested: chat.state.interruptRequested === true,
    binding: binding ? {
      ...binding,
      ...(binding.executionHost ? {
        executionHost: { ...binding.executionHost, host: { ...binding.executionHost.host } },
      } : {}),
    } : binding,
  };
}

export function invalidateChatMetadata(db: Database, userId: string, chatId: string): void {
  const cache = caches.get(db);
  if (cache && remove(cache, key(userId, chatId))) publish("invalidate");
}

export function invalidateChatMetadataForUser(
  db: Database,
  userId: string,
  matches: (chat: Chat) => boolean = () => true,
): void {
  const cache = caches.get(db);
  if (!cache) return;
  for (const [entryKey, entry] of cache.entries) {
    if (entry.userId === userId && matches(entry.chat)) {
      remove(cache, entryKey);
      publish("invalidate");
    }
  }
}

export function clearChatMetadataCache(db: Database): void {
  const cache = caches.get(db);
  if (!cache) return;
  caches.delete(db);
  publish("clear", cache.entries.size);
}
