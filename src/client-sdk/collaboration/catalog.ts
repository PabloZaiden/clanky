/**
 * Load public generated operation data, never server modules or handlers.
 */

import { CollaborationOperationCatalogSchema } from "@/contracts/schemas/collaboration-operation";
import type { CollaborationRouteOperation } from "@/shared/collaboration-operation";
import { DomainError } from "../../domain/domain-error";
import { readWorkspaceRequestBytes } from "./bodies";

export async function loadCollaborationOperations(url: string | URL, signal?: AbortSignal): Promise<CollaborationRouteOperation[]> {
  const response = await fetch(url, {
    credentials: "omit", cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DomainError("collaboration_catalog_unavailable", "The browser operation catalog could not be loaded.");
  }
  try {
    return CollaborationOperationCatalogSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      await readWorkspaceRequestBytes(response, 2 * 1_024 * 1_024),
    )));
  } catch (error) {
    throw new DomainError("collaboration_catalog_invalid", "The browser operation catalog is invalid.", { cause: error });
  }
}
