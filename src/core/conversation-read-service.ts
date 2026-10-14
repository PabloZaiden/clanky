/**
 * Literal chronological conversation pages, without runtime or tool payloads.
 */
import type { ConversationMessage, Page, ResourceReadOptions } from "@/contracts/schemas/resource-read";
import type { PersistedMessage } from "@/shared";
import { requireCurrentUserId } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { getConversationMessageWindowForUser, getConversationMessageIdsForUser, getConversationAdmissionsForUser, getTranscriptMetaForUser } from "../persistence/transcripts/sql-store";
import type { TranscriptResource } from "../persistence/transcripts/types";
import { DEFAULT_READ_BYTES, decodeReadCursor, encodeReadCursor, fitReadText, readBytes, readRevision } from "./resource-read-service";

function conversationPart(message: PersistedMessage, offset: number, admission: string | undefined): ConversationMessage {
  return {
    id: message.id, role: message.role, timestamp: message.timestamp,
    content: message.content.slice(offset), offset, complete: true,
    ...(message.role === "user" && admission && admission !== "delivered"
      ? { delivery: admission === "unknown" ? "unconfirmed" : admission }
      : message.question && message.role === "user" && message.question.status !== "answered"
        ? { delivery: message.question.status } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.length } : {}),
  };
}

export function readConversationPage(input: {
  resource: TranscriptResource; id: string; scope: string; options: ResourceReadOptions;
}): Page<ConversationMessage> | null {
  const userId = requireCurrentUserId();
  const meta = getTranscriptMetaForUser(input.resource, input.id, userId);
  if (!meta) return null;
  const admissions = getConversationAdmissionsForUser(input.resource, input.id, userId);
  const delivery = new Map(admissions.flatMap((entry) => [
    [entry.inputId, entry.status] as const,
    ...(entry.nativeMessageId ? [[entry.nativeMessageId, entry.status] as const] : []),
  ]));
  const ids = getConversationMessageIdsForUser(input.resource, input.id, userId);
  const membership = readRevision([ids, admissions]);
  const limit = input.options.limit ?? 20;
  let window: ReturnType<typeof getConversationMessageWindowForUser> | undefined;
  let windowPosition = 0;
  const messageAt = (position: number) => {
    if (!window) {
      windowPosition = position;
      window = getConversationMessageWindowForUser({
        resource: input.resource, resourceId: input.id, userId, position, limit: limit + 1,
      });
    }
    return window[position - windowPosition];
  };
  const revision = (position: number, offset: number): string => {
    if (position > ids.length) throw new DomainError("read_cursor_invalid", "Invalid conversation position.");
    if (!offset) return membership;
    const message = messageAt(position);
    if (!message) throw new DomainError("read_cursor_invalid", "Invalid conversation position.");
    return readRevision([membership, message]);
  };
  const cursor = decodeReadCursor({
    ...input.options,
    scope: input.options.range === "latest" ? readRevision([input.scope, "latest", limit]) : input.scope,
    revision: (value) => revision(value.position, value.offset),
  });
  const start = input.options.range === "latest" ? Math.max(0, ids.length - limit) : 0;
  const items: ConversationMessage[] = [];
  let position = input.options.cursor ? cursor.position : start, offset = cursor.offset;
  const maxBytes = input.options.maxBytes ?? DEFAULT_READ_BYTES;
  const context = input.options.range === "latest"
    ? { range: "latest", omittedEarlierMessages: start } : undefined;
  const page = (more: boolean): Page<ConversationMessage> => ({
    items,
    nextCursor: more ? encodeReadCursor({ ...cursor, position, offset, revision: revision(position, offset) }) : null,
    ...(context ? { context } : {}),
  });
  while (items.length < limit) {
    const message = messageAt(position);
    if (!message) {
      if (offset) throw new DomainError("read_cursor_invalid", "Invalid conversation position.");
      return page(false);
    }
    if (offset > message.content.length || offset && /[\uD800-\uDBFF]/u.test(message.content[offset - 1]!)) {
      throw new DomainError("read_cursor_invalid", "Invalid conversation offset.");
    }
    const part = conversationPart(message, offset, delivery.get(message.id));
    const text = part.content;
    const messageRevision = readRevision([membership, message]);
    items.push(part);
    const next = (): string => encodeReadCursor({ ...cursor,
      position: part.complete ? position + 1 : position,
      offset: part.complete ? 0 : offset + part.content.length,
      revision: part.complete ? membership : messageRevision,
    });
    if (readBytes({ items, nextCursor: next(), ...(context ? { context } : {}) }) > maxBytes) {
      const fitted = fitReadText(text, (chunk) => {
        part.content = chunk;
        part.complete = chunk.length === text.length;
        return readBytes({ items, nextCursor: next(), ...(context ? { context } : {}) }) <= maxBytes;
      });
      if (!fitted.length && text.length) {
        items.pop();
        if (!items.length) throw new DomainError("read_budget_too_small", "Increase maxBytes for this message.");
        return page(true);
      }
      part.content = fitted;
      part.complete = fitted.length === text.length;
      if (!part.complete) {
        offset += fitted.length;
        return page(true);
      }
      if (readBytes({ items, nextCursor: next(), ...(context ? { context } : {}) }) > maxBytes) {
        items.pop();
        if (!items.length) throw new DomainError("read_budget_too_small", "Increase maxBytes for this message.");
        return page(true);
      }
    }
    position++;
    offset = 0;
  }
  return page(messageAt(position) !== undefined);
}
