import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { executionHostRefFromParts, isPrivateMeshExecutionHostRef } from "@/shared/execution-host";
import { readReferenceField } from "@/shared/record";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { listAgentsByWorkspace, loadAgent, loadAgentRunSummary, loadAgentRunSummaryByChatId } from "../persistence/agents";
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
    if (chat.config.scope === "agent") {
      const run = await loadAgentRunSummaryByChatId(id);
      if (run) return await resourcePrivate("agent-run", run.id);
      if (!chat.config.workspaceId) return true;
      const parent = (await listAgentsByWorkspace(chat.config.workspaceId))
        .find((agent) => agent.config.generationChatId === id);
      return !parent || await resourcePrivate("agent", parent.config.id);
    }
    return chat.config.source?.kind === "execution_host"
      ? isPrivateMeshExecutionHostRef(chat.config.source.executionHost.host) : false;
  }
  if (resource === "agent") {
    const agent = await loadAgent(id);
    return !agent || agent.config.isPrivate === true || await workspacePrivate(agent.config.workspaceId);
  }
  if (resource === "agent-run") {
    const run = await loadAgentRunSummary(id);
    return !run || await resourcePrivate("agent", run.agentId) || await workspacePrivate(run.configSnapshot.workspaceId);
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
