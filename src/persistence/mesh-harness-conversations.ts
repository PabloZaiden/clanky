/**
 * Durable native ownership on the worker, independent of controller claims.
 */
import { getDatabase } from "./database";
import { HarnessConversationBindingSchema } from "@/contracts/schemas/harness";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { DomainError } from "../domain/domain-error";

export interface MeshHarnessConversationOwner {
  callerNodeId: string;
  workspaceId: string;
  ownerId: string;
}

export function requireMeshHarnessConversation(owner: MeshHarnessConversationOwner, binding: HarnessConversationBinding): void {
  const row = getDatabase().query(`
    SELECT controller_node_id, workspace_id, owner_id, binding_json
    FROM mesh_harness_conversations WHERE adapter = ? AND native_id = ?
  `).get(binding.adapter, binding.nativeId) as {
    controller_node_id: string; workspace_id: string; owner_id: string; binding_json: string;
  } | null;
  if (!row || row.controller_node_id !== owner.callerNodeId || row.workspace_id !== owner.workspaceId || row.owner_id !== owner.ownerId) {
    throw new DomainError("harness_session_not_owned", "The native conversation is not owned by this Mesh controller, user and workspace.");
  }
  requireMatchingHarnessBinding(row.binding_json, binding);
}

export function saveMeshHarnessConversation(owner: MeshHarnessConversationOwner, binding: HarnessConversationBinding): void {
  const validated = HarnessConversationBindingSchema.parse(binding);
  getDatabase().run(`
    INSERT INTO mesh_harness_conversations(adapter, native_id, controller_node_id, workspace_id, owner_id, binding_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(adapter, native_id) DO NOTHING
  `, [validated.adapter, validated.nativeId, owner.callerNodeId, owner.workspaceId, owner.ownerId, JSON.stringify(validated)]);
  requireMeshHarnessConversation(owner, validated);
}

export function deleteMeshHarnessConversation(owner: MeshHarnessConversationOwner, binding: HarnessConversationBinding): void {
  requireMeshHarnessConversation(owner, binding);
  getDatabase().run("DELETE FROM mesh_harness_conversations WHERE adapter = ? AND native_id = ?", [binding.adapter, binding.nativeId]);
}
