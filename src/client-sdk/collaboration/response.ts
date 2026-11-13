/**
 * Qualifies domain references at known response boundaries, never in content.
 */
import { isReadRecord } from "./resource-read";
import type { CollaborationResourceKind } from "@/shared/collaboration-reference";

const REFERENCE_FIELDS = {
  workspaceId: "workspace",
  chatId: "chat",
  subagentId: "subagent",
  automationId: "automation",
  runId: "automation-run",
  automationRunId: "automation-run",
  activeRunId: "automation-run",
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

function qualifyMessageAttachments(value: unknown, context: WorkspaceSourceResponseContext): unknown {
  if (!isReadRecord(value) || !Array.isArray(value["attachments"])) return value;
  return {
    ...value,
    attachments: value["attachments"].map((attachment: unknown) =>
      isReadRecord(attachment) && typeof attachment["resourceUrl"] === "string"
        ? { ...attachment, resourceUrl: context.qualifyUrl(attachment["resourceUrl"]) } : attachment),
  };
}

function qualifyTranscriptReferences(
  value: Record<string, unknown>,
  context: WorkspaceSourceResponseContext,
): Record<string, unknown> {
  const result = { ...value };
  if (result["message"] !== undefined) {
    result["message"] = qualifyMessageAttachments(result["message"], context);
  }
  if (isReadRecord(result["transcript"]) && Array.isArray(result["transcript"]["messages"])) {
    result["transcript"] = {
      ...result["transcript"],
      messages: result["transcript"]["messages"].map((message: unknown) => qualifyMessageAttachments(message, context)),
    };
  }
  if (result["type"] === "subagent.transcript" && isReadRecord(result["event"])
    && result["event"]["type"] === "transcript.message") {
    result["event"] = {
      ...result["event"],
      message: qualifyMessageAttachments(result["event"]["message"], context),
    };
  }
  return result;
}

function qualifyEntity(
  value: Record<string, unknown>,
  resource: CollaborationResourceKind,
  context: WorkspaceSourceResponseContext,
): Record<string, unknown> {
  const config = isReadRecord(value["config"]) ? value["config"] : value;
  if (["chat", "automation"].includes(String(config["mode"]))) resource = String(config["mode"]);
  else if (typeof config["remoteSessionName"] === "string") resource = "terminal";
  else if (typeof config["targetKind"] === "string" && typeof config["remotePort"] === "number") resource = "preview";
  else if (typeof value["automationId"] === "string" && isReadRecord(value["configSnapshot"])) resource = "automation-run";
  else if (isReadRecord(value["activity"]) && isReadRecord(value["binding"])
    && typeof value["chatId"] === "string") resource = "subagent";
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
  return qualifyTranscriptReferences(result, context);
}

const ENTITY_SLOTS = {
  workspace: "workspace",
  chat: "chat",
  automation: "automation",
  run: "automation-run",
  terminal: "terminal",
  terminalSession: "terminal",
  preview: "preview",
  subagent: "subagent",
} as const;

function isEntity(value: Record<string, unknown>): boolean {
  if (isReadRecord(value["config"])) return typeof value["config"]["id"] === "string";
  return typeof value["id"] === "string"
    && (typeof value["workspaceId"] === "string"
      || typeof value["executionTargetRevision"] === "number"
      || isReadRecord(value["details"])
      || isReadRecord(value["configSnapshot"])
      || isReadRecord(value["activity"]) && isReadRecord(value["binding"]));
}

export function qualifyWorkspaceResponse(
  value: unknown,
  context: WorkspaceSourceResponseContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => {
      if (!isReadRecord(entry)) return entry;
      if (context.resource === "workspace-controller" && typeof entry["id"] === "string") {
        return { ...entry, id: context.qualify("workspace-controller", entry["id"]),
          name: context.controllerName ?? entry["name"] };
      }
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
      typeof id === "string" ? context.qualify("automation-run", id) : id
    ));
  }
  return qualifyTranscriptReferences(result, context);
}
