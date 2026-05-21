/**
 * Internal helpers for the chats persistence layer.
 */

import type { Chat, ChatConfig, ChatState } from "../../types";
import { DEFAULT_CHAT_CONFIG } from "../../types/chat";
import { createLogger } from "../../core/logger";

const log = createLogger("persistence:chats");

export const ALLOWED_CHAT_COLUMNS = new Set([
  "id",
  "name",
  "workspace_id",
  "scope",
  "loop_id",
  "directory",
  "created_at",
  "updated_at",
  "model_provider_id",
  "model_model_id",
  "model_variant",
  "use_worktree",
  "auto_approve_permissions",
  "skip_base_branch_sync",
  "base_branch",
  "mode",
  "status",
  "started_at",
  "completed_at",
  "last_activity_at",
  "session_id",
  "session_server_url",
  "error_message",
  "error_timestamp",
  "error_code",
  "worktree_original_branch",
  "worktree_working_branch",
  "worktree_path",
  "messages",
  "logs",
  "tool_calls",
  "pending_permission_requests",
  "active_message_id",
  "interrupt_requested",
]);

export function validateChatColumnNames(columns: string[]): void {
  for (const column of columns) {
    if (!ALLOWED_CHAT_COLUMNS.has(column)) {
      throw new Error(`Invalid chat column name: ${column}`);
    }
  }
}

export function safeJsonParse<T>(json: string, fallback: T, fieldName: string, rowId: unknown): T {
  try {
    return JSON.parse(json);
  } catch (error) {
    log.warn(`Failed to parse JSON in field "${fieldName}" for chat ${String(rowId)}: ${String(error)}`);
    return fallback;
  }
}

export function chatToRow(chat: Chat): Record<string, unknown> {
  const { config, state } = chat;
  return {
    id: config.id,
    name: config.name,
    workspace_id: config.workspaceId,
    scope: config.scope,
    loop_id: config.loopId ?? null,
    directory: config.directory,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
    model_provider_id: config.model.providerID,
    model_model_id: config.model.modelID,
    model_variant: config.model.variant ?? null,
    use_worktree: config.useWorktree ? 1 : 0,
    auto_approve_permissions: config.autoApprovePermissions === false ? 0 : 1,
    skip_base_branch_sync: config.skipBaseBranchSync ? 1 : 0,
    base_branch: config.baseBranch ?? null,
    mode: config.mode,
    status: state.status,
    started_at: state.startedAt ?? null,
    completed_at: state.completedAt ?? null,
    last_activity_at: state.lastActivityAt ?? null,
    session_id: state.session?.id ?? null,
    session_server_url: state.session?.serverUrl ?? null,
    error_message: state.error?.message ?? null,
    error_timestamp: state.error?.timestamp ?? null,
    error_code: state.error?.code ?? null,
    worktree_original_branch: state.worktree?.originalBranch ?? null,
    worktree_working_branch: state.worktree?.workingBranch ?? null,
    worktree_path: state.worktree?.worktreePath ?? null,
    messages: JSON.stringify(state.messages),
    logs: JSON.stringify(state.logs),
    tool_calls: JSON.stringify(state.toolCalls),
    pending_permission_requests: JSON.stringify(state.pendingPermissionRequests ?? []),
    active_message_id: state.activeMessageId ?? null,
    interrupt_requested: state.interruptRequested ? 1 : 0,
  };
}

export function rowToChat(row: Record<string, unknown>): Chat {
  const rowId = row["id"];

  const config: ChatConfig = {
    id: row["id"] as string,
    name: row["name"] as string,
    workspaceId: row["workspace_id"] as string,
    scope: ((row["scope"] as ChatConfig["scope"] | null) ?? DEFAULT_CHAT_CONFIG.scope),
    loopId: (row["loop_id"] as string | null) ?? undefined,
    directory: row["directory"] as string,
    model: {
      providerID: (row["model_provider_id"] as string) ?? "unknown",
      modelID: (row["model_model_id"] as string) ?? "not-configured",
      variant: (row["model_variant"] as string | null) ?? "",
    },
    useWorktree: row["use_worktree"] === 1,
    autoApprovePermissions: row["auto_approve_permissions"] === undefined
      || row["auto_approve_permissions"] === null
      || row["auto_approve_permissions"] === 1,
    skipBaseBranchSync: row["skip_base_branch_sync"] === 1,
    baseBranch: (row["base_branch"] as string | null) ?? undefined,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    mode: ((row["mode"] as ChatConfig["mode"] | null) ?? DEFAULT_CHAT_CONFIG.mode),
  };

  const state: ChatState = {
    id: config.id,
    status: row["status"] as ChatState["status"],
    startedAt: (row["started_at"] as string | null) ?? undefined,
    completedAt: (row["completed_at"] as string | null) ?? undefined,
    lastActivityAt: (row["last_activity_at"] as string | null) ?? undefined,
    messages: row["messages"] ? safeJsonParse(row["messages"] as string, [], "messages", rowId) : [],
    logs: row["logs"] ? safeJsonParse(row["logs"] as string, [], "logs", rowId) : [],
    toolCalls: row["tool_calls"] ? safeJsonParse(row["tool_calls"] as string, [], "tool_calls", rowId) : [],
    pendingPermissionRequests: row["pending_permission_requests"]
      ? safeJsonParse(row["pending_permission_requests"] as string, [], "pending_permission_requests", rowId)
      : [],
    activeMessageId: (row["active_message_id"] as string | null) ?? undefined,
    interruptRequested: row["interrupt_requested"] === 1 ? true : undefined,
  };

  if (row["session_id"] !== null && row["session_id"] !== undefined) {
    state.session = {
      id: row["session_id"] as string,
      serverUrl: (row["session_server_url"] as string | null) ?? undefined,
    };
  }

  if (row["error_message"] !== null && row["error_message"] !== undefined) {
    state.error = {
      message: row["error_message"] as string,
      timestamp: (row["error_timestamp"] as string | null) ?? new Date(0).toISOString(),
      code: (row["error_code"] as string | null) ?? undefined,
    };
  }

  if (
    row["worktree_original_branch"] !== null
    && row["worktree_original_branch"] !== undefined
    && row["worktree_working_branch"] !== null
    && row["worktree_working_branch"] !== undefined
  ) {
    state.worktree = {
      originalBranch: row["worktree_original_branch"] as string,
      workingBranch: row["worktree_working_branch"] as string,
      worktreePath: (row["worktree_path"] as string | null) ?? undefined,
    };
  }

  return { config, state };
}
