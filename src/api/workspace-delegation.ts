/**
 * Shared reference locations declared by canonical workspace route definitions.
 */
import type { RouteDelegationMetadata } from "@pablozaiden/webapp/server";
import type { CollaborationResourceKind } from "@/shared/collaboration-reference";

export function workspaceOperation(
  resource: CollaborationResourceKind,
  options: { parameterResource?: CollaborationResourceKind; collection?: boolean } = {},
): RouteDelegationMetadata {
  return {
    resource,
    action: "work",
    ...(options.collection ? { collection: true } : {}),
    bindings: [
      { source: "param", name: "id", resource: options.parameterResource ?? resource },
      { source: "query", name: "workspaceId", resource: "workspace" },
      { source: "query", name: "item", resource: "read-item" },
      { source: "body", name: "workspaceId", resource: "workspace" },
      { source: "body", name: "chatId", resource: "chat" },
      { source: "body", name: "taskId", resource: "task" },
      { source: "body", name: "agentId", resource: "agent" },
      { source: "body", name: "commentIds", resource: "review-comment" },
      { source: "body", name: "source.workspaceId", resource: "workspace" },
    ],
  };
}
