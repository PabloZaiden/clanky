/**
 * Origin-qualified transport references; controller domain IDs stay unchanged.
 */

import { DomainError } from "../domain/domain-error";
import { z } from "zod";
import { decodeUtf8Base64Url, encodeJsonBase64Url } from "./encoding";

export const COLLABORATION_RESOURCE_KINDS = [
  "workspace", "task", "chat", "agent", "agent-run", "terminal", "preview",
  "review-comment", "execution-host", "read-item", "attachment",
  "provisioning-job", "worker-update-job", "subagent",
] as const;
export type KnownCollaborationResourceKind = typeof COLLABORATION_RESOURCE_KINDS[number];
export type CollaborationResourceKind = KnownCollaborationResourceKind | (string & {});

export const COLLABORATION_RESOURCE_REFERENCE_MAX_LENGTH = 2_048;
export const COLLABORATION_RESOURCE_ID_MAX_LENGTH = 512;

export interface CollaborationResourceReference {
  connectionId: string;
  resourceKind: CollaborationResourceKind;
  resourceId: string;
}

const PREFIX = "clanky.remote.v1.";
const ReferenceIdSchema = z.string().min(1).max(COLLABORATION_RESOURCE_ID_MAX_LENGTH)
  .refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));
export const CollaborationResourceReferenceSchema = z.object({
  connectionId: ReferenceIdSchema.max(200),
  // The operation catalog, not a transport reference, decides which kinds exist.
  resourceKind: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  resourceId: ReferenceIdSchema.refine((value) => !value.startsWith("clanky.remote.")),
}).strict();
const EncodedReferenceSchema = z.tuple([
  CollaborationResourceReferenceSchema.shape.connectionId,
  CollaborationResourceReferenceSchema.shape.resourceKind,
  CollaborationResourceReferenceSchema.shape.resourceId,
]);

function invalidReference(cause?: unknown): never {
  throw new DomainError("collaboration_reference_invalid", "The remote resource reference is invalid.", { cause });
}

function validateReference(value: unknown): CollaborationResourceReference {
  const result = EncodedReferenceSchema.safeParse(value);
  if (!result.success) return invalidReference();
  const [connectionId, resourceKind, resourceId] = result.data;
  return { connectionId, resourceKind, resourceId };
}

export function encodeCollaborationResourceReference(reference: CollaborationResourceReference): string {
  const parsed = CollaborationResourceReferenceSchema.safeParse(reference);
  if (!parsed.success) return invalidReference();
  const value = parsed.data;
  const encoded = encodeJsonBase64Url([value.connectionId, value.resourceKind, value.resourceId]);
  const result = `${PREFIX}${encoded}`;
  if (result.length > COLLABORATION_RESOURCE_REFERENCE_MAX_LENGTH) return invalidReference();
  return result;
}

/**
 * Local references are deliberately returned unchanged by the caller. A
 * malformed remote reference fails closed rather than becoming a local ID.
 */
export function decodeCollaborationResourceReference(
  reference: string,
): CollaborationResourceReference | undefined {
  if (!reference.startsWith("clanky.remote.")) return undefined;
  if (!reference.startsWith(PREFIX)
    || reference.length > COLLABORATION_RESOURCE_REFERENCE_MAX_LENGTH) return invalidReference();
  const encoded = reference.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalidReference();
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8Base64Url(encoded));
  } catch (error) {
    return invalidReference(error);
  }
  const parsed = validateReference(value);
  if (encodeCollaborationResourceReference(parsed) !== reference) return invalidReference();
  return parsed;
}
