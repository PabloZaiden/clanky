/**
 * Qualifies domain references at known response boundaries, never in content.
 */
import { isReadRecord } from "./resource-read";
import type { CollaborationResourceKind } from "@/shared/collaboration-reference";

const REFERENCE_FIELDS = {
  workspaceId: "workspace",
  taskId: "task",
  chatId: "chat",
  agentId: "agent",
  runId: "agent-run",
  agentRunId: "agent-run",
  activeRunId: "agent-run",
  generationChatId: "chat",
  terminalSessionId: "terminal",
  previewId: "preview",
} as const;

export interface WorkspaceSourceResponseContext {
  resource: CollaborationResourceKind;
  controllerName?: string;
  qualify(resource: CollaborationResourceKind, id: string): string;
  qualifyUrl(path: string): string;
}

function qualifyFields(
  value: Record<string, unknown>,
  context: WorkspaceSourceResponseContext,
): Record<string, unknown> {
  const result = { ...value };
  for (const [field, resource] of Object.entries(REFERENCE_FIELDS)) {
    if (typeof result[field] === "string") {
      result[field] = context.qualify(resource, result[field]);
    }
  }
  return result;
}

function qualifyHostBinding(
  value: unknown,
  context: WorkspaceSourceResponseContext,
): unknown {
  if (!isReadRecord(value)) return value;
  const result = { ...value };
  if (typeof result["hostId"] === "string") {
    result["hostId"] = context.qualify("execution-host", result["hostId"]);
  }
  if (isReadRecord(result["host"])) {
    result["host"] = qualifyFields(result["host"], context);
  }
  return result;
}

function qualifyEntity(
  value: Record<string, unknown>,
  resource: CollaborationResourceKind,
  context: WorkspaceSourceResponseContext,
): Record<string, unknown> {
  const config = isReadRecord(value["config"]) ? value["config"] : value;
  if (["task", "chat", "agent"].includes(String(config["mode"]))) resource = String(config["mode"]);
  else if (typeof config["remoteSessionName"] === "string") resource = "terminal";
  else if (typeof config["targetKind"] === "string" && typeof config["remotePort"] === "number") resource = "preview";
  else if (typeof value["agentId"] === "string" && isReadRecord(value["configSnapshot"])) resource = "agent-run";
  else if (typeof value["commentText"] === "string" && typeof value["taskId"] === "string") resource = "review-comment";
  const result = qualifyFields(value, context);
  if (resource === "workspace" && context.controllerName) {
    result["collaboration"] = { controllerName: context.controllerName };
  }
  if (typeof result["deletedAt"] === "string" && typeof result["origin"] === "string" && context.controllerName) {
    result["origin"] = `${result["origin"]} (${context.controllerName})`;
  }
  if (typeof result["id"] === "string") result["id"] = context.qualify(resource, result["id"]);
  for (const field of ["config", "configSnapshot", "state"]) {
    if (isReadRecord(result[field])) {
      const nested = qualifyFields(result[field], context);
      if (typeof nested["id"] === "string") nested["id"] = context.qualify(resource, nested["id"]);
      result[field] = qualifyEntityReferences(nested, context);
    }
  }
  if (isReadRecord(result["details"]) && typeof result["details"]["item"] === "string") {
    result["details"] = {
      ...result["details"],
      item: context.qualify("read-item", result["details"]["item"]),
    };
  }
  return qualifyEntityReferences(result, context);
}

function qualifyEntityReferences(
  value: Record<string, unknown>,
  context: WorkspaceSourceResponseContext,
): Record<string, unknown> {
  const result = { ...value };
  for (const field of ["executionHostBinding", "provisioningHostBinding"]) {
    if (result[field] !== undefined) result[field] = qualifyHostBinding(result[field], context);
  }
  if (isReadRecord(result["source"])) {
    const source = qualifyFields(result["source"], context);
    if (source["executionHost"] !== undefined) {
      source["executionHost"] = qualifyHostBinding(source["executionHost"], context);
    }
    result["source"] = source;
  }
  for (const field of ["downloadUrl", "iconUrl", "attachmentUrl"]) {
    if (typeof result[field] === "string") result[field] = context.qualifyUrl(result[field]);
  }
  return result;
}

const ENTITY_SLOTS = {
  workspace: "workspace",
  task: "task",
  chat: "chat",
  agent: "agent",
  run: "agent-run",
  terminal: "terminal",
  terminalSession: "terminal",
  preview: "preview",
  comment: "review-comment",
} as const;

function isEntity(value: Record<string, unknown>): boolean {
  if (isReadRecord(value["config"])) return typeof value["config"]["id"] === "string";
  return typeof value["id"] === "string"
    && (typeof value["workspaceId"] === "string"
      || typeof value["executionTargetRevision"] === "number"
      || isReadRecord(value["details"])
      || isReadRecord(value["configSnapshot"])
      || typeof value["commentText"] === "string");
}

export function qualifyWorkspaceResponse(
  value: unknown,
  context: WorkspaceSourceResponseContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => {
      if (!isReadRecord(entry)) return entry;
      if (isEntity(entry)) return qualifyEntity(entry, context.resource, context);
      if (context.resource === "execution-host" && isReadRecord(entry["ref"])) {
        return { ...entry, ref: qualifyFields(entry["ref"], context) };
      }
      return entry;
    });
  }
  if (!isReadRecord(value)) return value;
  if (isEntity(value)) return qualifyEntity(value, context.resource, context);
  const result = qualifyFields(value, context);
  for (const [field, resource] of Object.entries(ENTITY_SLOTS)) {
    if (isReadRecord(result[field])) result[field] = qualifyEntity(result[field], resource, context);
  }
  if (Array.isArray(result["items"])) {
    result["items"] = result["items"].map((entry: unknown) => isReadRecord(entry) && isEntity(entry)
      ? qualifyEntity(entry, context.resource, context) : entry);
  }
  if (Array.isArray(result["deletedRunIds"])) {
    result["deletedRunIds"] = result["deletedRunIds"].map((id: unknown) => (
      typeof id === "string" ? context.qualify("agent-run", id) : id
    ));
  }
  return result;
}
