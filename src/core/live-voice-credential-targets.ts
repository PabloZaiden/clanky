/**
 * Authoritative owned binding resolution for declarative credential selectors.
 */

import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { executionHostRefFromParts, getRegisteredSshServerId } from "@/shared/execution-host";
import { isRestartableAutomaticWorkspace } from "@/shared/workspace";
import { isStandaloneChat } from "@/shared/chat";
import type { ExecutionHostRef } from "@/shared/execution-host";
import type { PreparedOperation } from "./clanky-operation-service";
import { chatManager } from "./chat-manager";
import { workspaceManager } from "./workspace-manager";
import { sshServerManager } from "./ssh-server-manager";
import { getChatExecutionHostBinding } from "./chat-history-export-service";
import { DomainError } from "../domain/domain-error";

export async function resolveVoiceCredentialTargets(operation: PreparedOperation): Promise<{
  serverIds: string[];
  revision: string;
}> {
  const credential = operation.metadata.automation.credential;
  if (!credential) return { serverIds: [], revision: "" };
  const body = operation.body && typeof operation.body === "object" ? operation.body : {};
  const hosts: ExecutionHostRef[] = [];
  const resources: string[] = [];
  if (credential.serverParameter) {
    const id = operation.parameters[credential.serverParameter];
    const kind = operation.parameters["kind"] ?? "ssh";
    const ref = id ? executionHostRefFromParts(kind, id) : null;
    if (!ref) throw new DomainError("voice_operation_target", "The execution-host reference is invalid.");
    hosts.push(ref);
  } else if (credential.hostInput) {
    const raw = Object.getOwnPropertyDescriptor(body, credential.hostInput)?.value;
    if (raw !== undefined && raw !== null) hosts.push(ExecutionHostRefSchema.parse(raw));
  } else if (credential.resource) {
    const selector = credential.resource;
    const id = selector.idParameter ? operation.parameters[selector.idParameter] : undefined;
    if (selector.name === "chats" && selector.purpose === "trash-cleanup") {
      resources.push(id ?? "trash");
      for (const serverId of chatManager.getTrashCredentialTargets(id)) {
        hosts.push({ kind: "ssh", serverId });
      }
    } else if (selector.name === "chats" && id) {
      const chat = await chatManager.getChat(id);
      if (!chat) throw new DomainError("voice_operation_target", "The chat is unavailable.");
      const recovery = chat.state.harness?.historyRecovery;
      if (selector.purpose === "connection") {
        if (chat.config.source?.kind === "execution_host") hosts.push(chat.config.source.executionHost.host);
        if (recovery && recovery.status !== "complete") hosts.push(recovery.executionHost.host);
      } else if (selector.purpose === "history-cleanup") {
        if (!isStandaloneChat(chat) && recovery && recovery.status !== "complete") hosts.push(recovery.executionHost.host);
      } else if (selector.purpose === "continue-history") {
        hosts.push((await getChatExecutionHostBinding({
          getWorkspace: (workspaceId) => workspaceManager.getWorkspace(workspaceId),
        }, chat)).host);
        if (recovery && recovery.status !== "complete") hosts.push(recovery.executionHost.host);
      } else throw new DomainError("voice_operation_contract", "The credential purpose is unsupported.");
    } else if (selector.name === "workspaces") {
      if (selector.purpose === "directory-delete" && id) {
        const workspace = await workspaceManager.requireWorkspace(id);
        if ("deleteServerDirectory" in body && body.deleteServerDirectory === true) {
          hosts.push((workspace.provisioningHostBinding ?? workspace.executionHostBinding).host);
        }
      } else if (selector.purpose === "restart-automatic") {
        const workspaces = (await workspaceManager.listWorkspaces()).filter(isRestartableAutomaticWorkspace);
        for (const workspace of workspaces) {
          resources.push(workspace.id);
          hosts.push((workspace.provisioningHostBinding ?? workspace.executionHostBinding).host);
        }
      } else throw new DomainError("voice_operation_contract", "The credential purpose is unsupported.");
    } else throw new DomainError("voice_operation_contract", "The credential resource is unsupported.");
  } else throw new DomainError("voice_operation_contract", "The credential selector is missing.");
  const serverIds = [...new Set(hosts.flatMap((host) => {
    const id = getRegisteredSshServerId(host);
    return id ? [id] : [];
  }))].sort();
  const servers: { id: string; host: string; port: number; username: string }[] = [];
  for (const id of serverIds) {
    const server = await sshServerManager.getServer(id);
    if (!server) throw new DomainError("ssh_server_not_found", "The selected SSH server is unavailable.");
    servers.push({ id, host: server.config.address, port: server.config.port ?? 22, username: server.config.username });
  }
  if (!credential.mapInput && serverIds.length > 1) {
    throw new DomainError("voice_credential_targets_conflict", "This operation needs different SSH servers but its API accepts one token. Use the normal history/cleanup workflow first.");
  }
  return { serverIds, revision: JSON.stringify({ resources, hosts, servers }) };
}
