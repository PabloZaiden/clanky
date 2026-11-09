import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { executionHostRefFromParts, isPrivateMeshExecutionHostRef } from "@/shared/execution-host";
import { readReferenceField } from "@/shared/record";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { listAutomationsByWorkspace, loadAutomation, loadAutomationRunSummary, loadAutomationRunSummaryByChatId } from "../persistence/automations";
import { getTerminalSession } from "../persistence/terminal-sessions";
import { getWorkspace } from "../persistence/workspaces";
import type { PreparedOperation } from "./clanky-operation-service";

async function workspacePrivate(id: string): Promise<boolean> {
  const workspace = await getWorkspace(id);
  return !workspace || workspace.isPrivate === true;
}

export async function resourcePrivate(resource: string, id: string): Promise<boolean> {
  if (resource === "workspace") return await workspacePrivate(id);
  if (resource === "task") {
    const task = await loadTaskSummary(id);
    return !task || task.config.isPrivate === true || await workspacePrivate(task.config.workspaceId);
  }
  if (resource === "chat") {
    const chat = await loadChatMetadata(id);
    if (!chat || chat.config.isPrivate === true) return true;
    if (chat.config.workspaceId && await workspacePrivate(chat.config.workspaceId)) return true;
    if (chat.config.scope === "task" || chat.config.taskId) {
      return !chat.config.taskId || await resourcePrivate("task", chat.config.taskId);
    }
    if (chat.config.scope === "automation") {
      const run = await loadAutomationRunSummaryByChatId(id);
      if (run) return await resourcePrivate("automation-run", run.id);
      if (!chat.config.workspaceId) return true;
      const parent = (await listAutomationsByWorkspace(chat.config.workspaceId))
        .find((automation) => automation.config.generationChatId === id);
      return !parent || await resourcePrivate("automation", parent.config.id);
    }
    return chat.config.source?.kind === "execution_host"
      ? isPrivateMeshExecutionHostRef(chat.config.source.executionHost.host) : false;
  }
  if (resource === "automation") {
    const automation = await loadAutomation(id);
    return !automation || automation.config.isPrivate === true || await workspacePrivate(automation.config.workspaceId);
  }
  if (resource === "automation-run") {
    const run = await loadAutomationRunSummary(id);
    return !run || await resourcePrivate("automation", run.automationId) || await workspacePrivate(run.configSnapshot.workspaceId);
  }
  if (resource === "terminal") {
    const terminal = await getTerminalSession(id);
    if (!terminal || terminal.config.isPrivate === true
      || isPrivateMeshExecutionHostRef(terminal.config.executionHostBinding.host)) return true;
    if (terminal.config.taskId && await resourcePrivate("task", terminal.config.taskId)) return true;
    return terminal.config.workspaceId ? await workspacePrivate(terminal.config.workspaceId) : false;
  }
  return true;
}

export async function controlRequestPrivate(operation?: PreparedOperation): Promise<boolean> {
  // Missing targets stay obscured until the human reviews the frozen request.
  if (!operation) return false;
  if (operation.input.bodyFile || operation.input.headersFile || operation.input.responseFile) return true;
  if (readReferenceField(operation.body, "isPrivate") === true) return true;
  const bindings = operation.metadata.delegation ? operation.metadata.delegation.bindings ?? [] : [];
  for (const binding of bindings) {
    const value = binding.source === "param" ? operation.parameters[binding.name]
      : binding.source === "query" ? operation.input.query.find(({ name }) => name === binding.name)?.value
        : readReferenceField(operation.body, binding.name);
    if (typeof value === "string" && await resourcePrivate(binding.resource, value)) return true;
  }
  if (operation.entry.path.startsWith("/api/execution-hosts/")) {
    const host = executionHostRefFromParts(operation.parameters["kind"] ?? "", operation.parameters["id"] ?? "");
    if (!host || isPrivateMeshExecutionHostRef(host)) return true;
  }
  const host = readReferenceField(operation.body, "executionHost");
  if (host !== undefined && host !== null && isPrivateMeshExecutionHostRef(ExecutionHostRefSchema.parse(host))) return true;
  return false;
}
