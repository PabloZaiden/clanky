/**
 * Durable execution-host locations; original attachment bytes stay in messages.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { AttachmentContext } from "@/shared/message-attachments";
import type { ExecutionHostBinding } from "@/shared/execution-host";
import { ExecutionHostBindingSchema } from "@/contracts/schemas/execution-host";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";

const log = createLogger("persistence:attachment-locations");

export interface AttachmentLocation {
  id: string;
  executionHost: ExecutionHostBinding;
  directory: string;
}

export function assertAttachmentContextActive(context: AttachmentContext): void {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const row = context.kind === "chat"
    ? db.query("SELECT id FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL").get(context.id, userId)
    : db.query("SELECT id FROM tasks WHERE id = ? AND user_id = ? AND status != 'deleted'").get(context.id, userId);
  if (!row) {
    throw new DomainError("attachment_context_unavailable", "The attachment conversation is no longer available.");
  }
}

export function rememberAttachmentLocation(context: AttachmentContext, location: AttachmentLocation): void {
  const db = getDatabase();
  db.transaction(() => {
    assertAttachmentContextActive(context);
    db.query(`
      INSERT INTO conversation_attachment_locations
        (user_id, context_kind, context_id, location_id, execution_host_json, directory)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, context_kind, context_id, location_id) DO NOTHING
    `).run(requirePersistenceUserId(), context.kind, context.id, location.id,
      JSON.stringify(location.executionHost), location.directory);
  })();
}

export function listAttachmentLocations(context: AttachmentContext): AttachmentLocation[] {
  const rows = getDatabase().query<{
    location_id: string;
    execution_host_json: string;
    directory: string;
  }, [string, string, string]>(`
    SELECT location_id, execution_host_json, directory FROM conversation_attachment_locations
    WHERE user_id = ? AND context_kind = ? AND context_id = ?
  `).all(requirePersistenceUserId(), context.kind, context.id);
  return rows.map((row) => {
    try {
      return {
        id: row.location_id,
        executionHost: ExecutionHostBindingSchema.parse(JSON.parse(row.execution_host_json)),
        directory: row.directory,
      };
    } catch (error) {
      log.warn("Stored attachment location is invalid", { contextId: context.id, locationId: row.location_id });
      throw new DomainError("attachment_location_invalid", "A saved attachment location is invalid.", { cause: error });
    }
  });
}

export function forgetAttachmentLocation(context: AttachmentContext, locationId: string): void {
  getDatabase().query(`
    DELETE FROM conversation_attachment_locations
    WHERE user_id = ? AND context_kind = ? AND context_id = ? AND location_id = ?
  `).run(requirePersistenceUserId(), context.kind, context.id, locationId);
}
