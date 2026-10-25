/**
 * Bounded metadata and verified bodies for the private relay gateway.
 */
import type { WorkspaceClientRequestMetadata } from "@/contracts/schemas/mesh-client";
import { MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES } from "@/shared/message-attachments";
import { DomainError } from "../domain/domain-error";
import { readWorkspaceRequestBytes } from "../client-sdk/collaboration/bodies";

export { readWorkspaceRequestBytes } from "../client-sdk/collaboration/bodies";

export async function verifyWorkspaceBody(
  request: Request,
  metadata: WorkspaceClientRequestMetadata,
  maxBytes = MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!metadata.bodySha256) {
    throw new DomainError("collaboration_request_invalid", "A signed body digest is required.");
  }
  const bytes = await readWorkspaceRequestBytes(request, maxBytes);
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== metadata.bodySha256) {
    throw new DomainError("collaboration_request_invalid", "The workspace request body does not match its proof.");
  }
  return bytes;
}

export async function reconstructWorkspaceRequest(
  request: Request,
  metadata: WorkspaceClientRequestMetadata,
): Promise<Request> {
  const bodyless = metadata.method === "GET" || metadata.method === "HEAD";
  const json = metadata.headers["content-type"]?.split(";")[0]?.trim() === "application/json";
  const body = bodyless ? undefined : metadata.bodySha256 || json
    ? await verifyWorkspaceBody(request, metadata) : request.body;
  return new Request(new URL(metadata.path, "https://mesh.invalid"), {
    method: metadata.method,
    headers: metadata.headers,
    body,
    signal: request.signal,
  });
}
