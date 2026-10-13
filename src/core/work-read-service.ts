/**
 * Source-paged work metadata using the same read envelope and cursor service.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { ResourceReadOptions, Page } from "@/contracts/schemas/resource-read";
import { requireCurrentUserId } from "../context/user-context";
import { listWorkReadIds, listWorkReadWindow, type WorkReadResource, type StoredWorkReadRow } from "../persistence/resource-reads";
import { collectionReadPage, decodeReadCursor, readRevision, resourceKey, fitCompactMetadata } from "./resource-read-service";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { loadAgentRunSummary } from "../persistence/agents";
import { DomainError } from "../domain/domain-error";
import { getExecutionHostById } from "../persistence/execution-hosts";

const log = createLogger("core:work-reads");
export type { WorkReadResource } from "../persistence/resource-reads";

function workMetadata(row: StoredWorkReadRow, resource: WorkReadResource): Record<string, unknown> {
  if (!row.stateAvailable) log.warn("Compact work state is unavailable", { resource, id: row.id });
  return {
    id: row.id, name: row.name, workspaceId: row.workspaceId, directory: row.directory,
    status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    model: row.providerID && row.modelID ? { providerID: row.providerID, modelID: row.modelID, variant: row.variant ?? "" } : null,
    source: row.sourceKind === "execution_host" ? {
      kind: "execution_host",
      host: row.executionHostId ? getExecutionHostById(requireCurrentUserId(), row.executionHostId)?.ref ?? null : null,
      directory: row.directory,
    } : { kind: "workspace", workspaceId: row.workspaceId },
    ...(row.agentId ? { agentId: row.agentId, chatId: row.chatId } : {}),
    ...(row.taskId ? { taskId: row.taskId } : {}),
    ...(row.currentIteration !== null ? { currentIteration: row.currentIteration } : {}),
    ...(row.stateAvailable ? {
      needsInput: row.pendingQuestions + row.pendingPermissions > 0,
      pendingQuestions: row.pendingQuestions, pendingPermissions: row.pendingPermissions,
      pendingInputs: row.pendingInputs,
    } : { stateUnavailable: true }),
    details: { section: "details", item: resourceKey({ id: row.id }) },
  };
}

export function readWorkMetadata(input: { resource: WorkReadResource; id: string; maxBytes: number }): Record<string, unknown> | null {
  const row = listWorkReadWindow({ ...input, userId: requireCurrentUserId() }, 0, 1)[0];
  return row ? fitCompactMetadata(workMetadata(row, input.resource), input.maxBytes) : null;
}

export async function readWorkCollectionItem(input: {
  resource: WorkReadResource; options: ResourceReadOptions; workspaceId?: string; agentId?: string;
}): Promise<unknown> {
  const id = listWorkReadIds({ ...input, userId: requireCurrentUserId() })
    .find((candidate) => resourceKey({ id: candidate }) === input.options.item);
  if (!id) throw new DomainError("read_item_unavailable", "The selected item is unavailable.");
  return input.resource === "chat" ? await loadChatMetadata(id)
    : input.resource === "task" ? await loadTaskSummary(id) : await loadAgentRunSummary(id);
}

export function readWorkCollection(input: {
  resource: WorkReadResource; scope: string; options: ResourceReadOptions;
  workspaceId?: string; agentId?: string; baseOffset?: number;
}): Page<unknown> {
  const source = { ...input, userId: requireCurrentUserId() };
  const allIds = listWorkReadIds(source);
  const ids = allIds.slice(input.baseOffset ?? 0);
  const revision = readRevision(ids);
  const cursor = decodeReadCursor({ ...input.options, scope: input.scope, revision });
  const rows = listWorkReadWindow(source, cursor.position + (input.baseOffset ?? 0), (input.options.limit ?? 20) + 1);
  const summaries = rows.map((row) => workMetadata(row, input.resource));
  return collectionReadPage({
    source: summaries, options: input.options, scope: input.scope,
    revision, startPosition: cursor.position, totalCount: ids.length,
  });
}
