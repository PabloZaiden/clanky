/**
 * Stateless bounded Trash pagination across independently authorized origins.
 */
import {
  decodeChatTrashCursor, encodeChatTrashCursor, type ChatTrashPage,
} from "@/contracts/schemas/chat-trash";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { DomainError } from "../../domain/domain-error";

function position(id: string): { origin: string; id: string } {
  const reference = decodeCollaborationResourceReference(id);
  if (reference && reference.resourceKind !== "chat") {
    throw new DomainError("invalid_trash_cursor", "A Trash cursor must identify a chat.");
  }
  return { origin: reference?.connectionId ?? "", id: reference?.resourceId ?? id };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function trashCursorForSource(cursor: string, connectionId = ""): string {
  const value = decodeChatTrashCursor(cursor);
  const source = position(value.id);
  if (source.origin === connectionId) return encodeChatTrashCursor({ ...value, id: source.id });
  // Other origins need the whole timestamp boundary, not a fabricated domain ID.
  return encodeChatTrashCursor({
    deletedAt: value.deletedAt, id: source.id,
    timestampBoundary: connectionId < source.origin ? "inclusive" : "exclusive",
  });
}

export function mergeChatTrashPages(pages: ChatTrashPage[], limit: number): ChatTrashPage {
  const sorted = pages.flatMap((page) => page.items).sort((left, right) => {
    const a = position(left.id), b = position(right.id);
    return compare(right.deletedAt, left.deletedAt)
      || compare(b.origin, a.origin) || compare(b.id, a.id);
  });
  const items = sorted.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: last && (sorted.length > limit || pages.some((page) => page.nextCursor !== null))
      ? encodeChatTrashCursor({ deletedAt: last.deletedAt, id: last.id }) : null,
  };
}
