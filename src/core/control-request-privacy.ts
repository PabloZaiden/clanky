import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import {
  executionHostRefFromParts, getRegisteredSshServerId, isPrivateMeshExecutionHostRef,
  isWorkspaceSshExecutionHostRef, type ExecutionHostRef,
} from "@/shared/execution-host";
import { readReferenceField } from "@/shared/record";
import { loadChatMetadata } from "../persistence/chats";
import { loadTaskSummary } from "../persistence/tasks";
import { getWorkspace } from "../persistence/workspaces";
import { sshServerManager } from "./ssh-server-manager";
import type { PreparedOperation } from "./clanky-operation-service";

async function workspacePrivate(id: string): Promise<boolean> {
  const workspace = await getWorkspace(id);
  return !workspace || workspace.isPrivate === true;
}

async function serverPrivate(id: string): Promise<boolean> {
  const server = await sshServerManager.getServer(id);
  return !server || server.config.isPrivate === true;
}

async function hostPrivate(host: ExecutionHostRef): Promise<boolean> {
  if (isPrivateMeshExecutionHostRef(host)) return true;
  if (isWorkspaceSshExecutionHostRef(host)) return await workspacePrivate(host.workspaceId);
  const serverId = getRegisteredSshServerId(host);
  return serverId ? await serverPrivate(serverId) : false;
}

async function resourcePrivate(resource: string, id: string): Promise<boolean> {
  if (resource === "workspace") return await workspacePrivate(id);
  if (resource === "task") {
    const task = await loadTaskSummary(id);
    return !task || task.config.isPrivate === true || await workspacePrivate(task.config.workspaceId);
  }
  if (resource === "chat") {
    const chat = await loadChatMetadata(id);
    if (!chat || chat.config.isPrivate === true) return true;
    if (chat.config.workspaceId) return await workspacePrivate(chat.config.workspaceId);
    return chat.config.source?.kind === "execution_host"
      ? await hostPrivate(chat.config.source.executionHost.host) : false;
  }
  return false;
}

export async function controlRequestPrivate(operation?: PreparedOperation, serverId?: string): Promise<boolean> {
  // Missing targets stay obscured until the human reviews the frozen request.
  if (serverId && await serverPrivate(serverId)) return true;
  if (!operation) return false;
  if (readReferenceField(operation.body, "isPrivate") === true) return true;
  const bindings = operation.metadata.delegation ? operation.metadata.delegation.bindings ?? [] : [];
  for (const binding of bindings) {
    const value = binding.source === "param" ? operation.parameters[binding.name]
      : binding.source === "query" ? operation.input.query.find(({ name }) => name === binding.name)?.value
        : readReferenceField(operation.body, binding.name);
    if (typeof value === "string" && await resourcePrivate(binding.resource, value)) return true;
  }
  if (operation.entry.path.startsWith("/api/ssh-servers/") && operation.parameters["id"]
    && await serverPrivate(operation.parameters["id"])) return true;
  const credential = operation.metadata.automation.credential;
  if (credential?.serverParameter) {
    const host = executionHostRefFromParts(
      operation.parameters["kind"] ?? "ssh", operation.parameters[credential.serverParameter] ?? "",
    );
    if (!host || await hostPrivate(host)) return true;
  }
  if (credential?.hostInput) {
    const host = readReferenceField(operation.body, credential.hostInput);
    if (host !== undefined && host !== null && await hostPrivate(ExecutionHostRefSchema.parse(host))) return true;
  }
  return false;
}
