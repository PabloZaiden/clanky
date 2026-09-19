/**
 * Typed API-boundary policy for translating DomainError values into safe
 * public HTTP responses.
 *
 * Domain errors remain transport-neutral. This module is intentionally owned
 * by the API layer so route boundaries can share status/code/message policy
 * without leaking HTTP concerns into Core or Persistence.
 */

import { isDomainError, type DomainError } from "../core/domain-error";

export type DomainErrorBoundary =
  | "authenticated"
  | "mesh"
  | "mesh-internal"
  | "mesh-relay"
  | "transport";

export type DomainErrorPolicyName =
  | "authenticated"
  | "agents"
  | "agents-md"
  | "chats"
  | "execution-hosts"
  | "file-explorer"
  | "mesh"
  | "mesh-internal"
  | "mesh-relay"
  | "previews"
  | "provisioning"
  | "settings"
  | "ssh"
  | "tasks"
  | "terminal"
  | "transcript"
  | "transport"
  | "vnc"
  | "voice"
  | "workspaces";

export interface DomainErrorHttpMapping {
  status: number;
  error?: string;
  message?: string;
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}

type DomainErrorDetailProjector = (
  error: DomainError,
) => Record<string, unknown> | undefined;

type DomainErrorMessageProjector = (
  error: DomainError,
) => string | undefined;

type DomainErrorHeaderProjector = (
  error: DomainError,
) => Record<string, string> | undefined;

interface DomainErrorHttpPolicyEntry {
  status: number;
  error?: string;
  message?: string;
  messageFromDetails?: DomainErrorMessageProjector;
  messageFromError?: DomainErrorMessageProjector;
  extra?: DomainErrorDetailProjector;
  headers?: DomainErrorHeaderProjector;
}

interface DomainErrorPolicyProfile {
  boundary: DomainErrorBoundary;
  mappings: Readonly<Partial<Record<ApiDomainErrorCode, DomainErrorHttpPolicyEntry>>>;
  unknownStatus?: (code: string) => number | undefined;
}

/**
 * Codes explicitly handled at an API boundary. Keeping this list separate
 * from DomainError's intentionally open string code makes policy keys
 * compile-time checked while unknown internal codes still fail safely.
 */
const API_DOMAIN_ERROR_CODES = {
  acp_connection_aborted: true,
  acp_connection_timed_out: true,
  acp_request_cancelled: true,
  acp_session_not_found: true,
  acp_ssh_authentication_failed: true,
  acp_unsupported_prompt_capability: true,
  agent_already_running: true,
  agent_chat_not_found: true,
  agent_code_generation_failed: true,
  agent_code_invalid: true,
  agent_not_found: true,
  agent_run_not_ready: true,
  agents_md_read_failed: true,
  agents_md_write_failed: true,
  automatic_pr_flow_busy: true,
  automatic_pr_flow_disabled: true,
  conflict: true,
  directory_in_use: true,
  execution_host_addresses_unavailable: true,
  execution_host_binding_stale: true,
  execution_host_capability_unavailable: true,
  execution_host_configuration_unsupported: true,
  execution_host_directory_invalid: true,
  execution_host_exec_cwd_invalid: true,
  execution_host_exec_cwd_not_found: true,
  execution_host_exec_output_limit_exceeded: true,
  execution_host_kind_invalid: true,
  execution_host_name_ambiguous: true,
  execution_host_not_found: true,
  execution_host_private: true,
  execution_host_reference_required: true,
  execution_host_unavailable: true,
  execution_host_addresses_failed: true,
  execution_host_templates_failed: true,
  execution_host_provider_discovery_failed: true,
  execution_host_model_discovery_failed: true,
  execution_host_chat_failed: true,
  execution_host_configuration_failed: true,
  execution_host_directory_unavailable: true,
  execution_host_exec_failed: true,
  execution_host_prerequisites_failed: true,
  execution_host_working_directory_unavailable: true,
  execution_host_execution_target_invalid: true,
  directory_not_found: true,
  operation_failed: true,
  start_directory_not_found: true,
  invalid_start_directory_type: true,
  file_not_found: true,
  invalid_path_type: true,
  invalid_path: true,
  root_not_mutable: true,
  invalid_file_name: true,
  upload_session_not_found: true,
  upload_session_target_mismatch: true,
  upload_size_exceeded: true,
  invalid_upload_state: true,
  invalid_preview_type: true,
  invalid_credential_token: true,
  invalid_encrypted_credential: true,
  invalid_execution_target: true,
  invalid_model_config: true,
  invalid_uploaded_plan: true,
  invalid_task_input: true,
  cheap_model_not_enabled: true,
  model_not_enabled: true,
  model_not_found: true,
  provider_not_found: true,
  invalid_task_state: true,
  invalid_worker_host_address: true,
  job_not_terminal: true,
  mesh_acp_unavailable: true,
  mesh_control_request_rejected: true,
  mesh_control_request_unreachable: true,
  mesh_endpoint_invalid: true,
  mesh_endpoint_protocol_invalid: true,
  mesh_endpoint_transport_mismatch: true,
  mesh_enrollment_controller_mismatch: true,
  mesh_enrollment_discovery_invalid: true,
  mesh_enrollment_discovery_rejected: true,
  mesh_enrollment_discovery_timeout: true,
  mesh_enrollment_discovery_too_large: true,
  mesh_enrollment_discovery_unreachable: true,
  mesh_enrollment_expired: true,
  mesh_enrollment_relay_identity_invalid: true,
  mesh_enrollment_relay_mismatch: true,
  mesh_enrollment_relay_unpaired: true,
  mesh_enrollment_response_invalid: true,
  mesh_enrollment_self: true,
  mesh_enrollment_target_invalid: true,
  mesh_enrollment_token_invalid: true,
  mesh_execution_aborted: true,
  mesh_execution_async_command_not_found: true,
  mesh_execution_caller_not_active: true,
  mesh_execution_cancel_failed: true,
  mesh_execution_capability_unavailable: true,
  mesh_execution_command_failed: true,
  mesh_execution_configuration_request_expired: true,
  mesh_execution_configuration_stale: true,
  mesh_execution_context_changed: true,
  mesh_execution_encryption_key_invalid: true,
  mesh_execution_encryption_unavailable: true,
  mesh_execution_endpoint_unavailable: true,
  mesh_execution_environment_invalid: true,
  mesh_execution_environment_unavailable: true,
  mesh_execution_limit_exceeded: true,
  mesh_execution_operation_unsupported: true,
  mesh_execution_output_gap: true,
  mesh_execution_output_offset_invalid: true,
  mesh_execution_owner_mismatch: true,
  mesh_execution_path_invalid: true,
  mesh_execution_protocol_mismatch: true,
  mesh_execution_replay: true,
  mesh_execution_request_failed: true,
  mesh_execution_request_invalid: true,
  mesh_execution_request_too_large: true,
  mesh_execution_response_invalid: true,
  mesh_execution_result_too_large: true,
  mesh_execution_session_expired: true,
  mesh_execution_session_expiry_invalid: true,
  mesh_execution_session_invalid: true,
  mesh_execution_target_invalid: true,
  mesh_execution_unreachable: true,
  mesh_peer_not_trusted: true,
  mesh_peer_revoked: true,
  mesh_peer_target_invalid: true,
  mesh_relay_authorization_failed: true,
  mesh_relay_controller_identity_changed: true,
  mesh_relay_controller_mismatch: true,
  mesh_relay_descriptor_invalid: true,
  mesh_relay_descriptor_rejected: true,
  mesh_relay_descriptor_too_large: true,
  mesh_relay_descriptor_unreachable: true,
  mesh_relay_not_paired: true,
  mesh_relay_pairing_auth_failed: true,
  mesh_relay_unavailable: true,
  mesh_relay_url_invalid: true,
  mesh_public_base_url_not_configured: true,
  mesh_role_invalid: true,
  mesh_terminal_capability_mismatch: true,
  mesh_terminal_context_changed: true,
  mesh_terminal_capability_unavailable: true,
  mesh_terminal_session_expired: true,
  mesh_terminal_session_invalid: true,
  mesh_terminal_target_invalid: true,
  mesh_tunnel_target_invalid: true,
  mesh_worker_kill_expired: true,
  mesh_worker_kill_invalid_signature: true,
  mesh_worker_not_found: true,
  mesh_worker_relay_grants_inconsistent: true,
  not_git_repo: true,
  operation_in_progress: true,
  reset_failed: true,
  purge_terminal_tasks_failed: true,
  plan_not_ready: true,
  preview_server_unsupported: true,
  provisioning_target_busy: true,
  provisioning_cancelled: true,
  quick_chat_model_mismatch: true,
  ssh_server_key_generation_failed: true,
  ssh_server_not_found: true,
  ssh_server_reload_failed: true,
  task_already_running: true,
  task_branch_missing: true,
  task_file_operation_failed: true,
  task_git_operation_failed: true,
  task_no_remote: true,
  task_not_addressable: true,
  task_not_found: true,
  task_not_planning: true,
  task_not_running: true,
  task_operation_failed: true,
  task_session_reconnect_failed: true,
  task_terminal_session_failed: true,
  task_worktree_missing: true,
  task_working_directory_unavailable: true,
  base_branch_immutable: true,
  use_worktree_immutable: true,
  active_task_update_restricted: true,
  planning_update_restricted: true,
  plan_execution_update_restricted: true,
  task_rename_restricted: true,
  mesh_terminal_connection_unavailable: true,
  mesh_terminal_link_unavailable: true,
  mesh_terminal_target_unavailable: true,
  terminal_connection_unavailable: true,
  terminal_directory_unavailable: true,
  terminal_execution_target_changed: true,
  terminal_persistent_session_attach_unavailable: true,
  terminal_session_closing: true,
  terminal_session_not_found: true,
  terminal_target_mismatch: true,
  transcript_cursor_invalid: true,
  uncommitted_changes: true,
  validation_failed: true,
  vnc_session_not_active: true,
  vnc_session_not_found: true,
  vnc_session_start_failed: true,
  vnc_tunnel_failed: true,
  voice_audio_too_large: true,
  voice_capability_not_configured: true,
  voice_capability_unavailable: true,
  voice_invalid_base_url: true,
  voice_not_configured: true,
  voice_provider_invalid_request: true,
  voice_provider_invalid_response: true,
  voice_provider_rate_limited: true,
  voice_provider_redirect: true,
  voice_provider_request_failed: true,
  voice_provider_response_too_large: true,
  voice_provider_timeout: true,
  voice_provider_unreachable: true,
  voice_unsafe_provider_url: true,
  voice_validation_stale: true,
  voice_text_too_large: true,
  workspace_delete_metadata_invalid: true,
  workspace_delete_remote_failed: true,
  workspace_deletion_in_progress: true,
  workspace_execution_target_in_use: true,
  workspace_execution_target_missing: true,
  workspace_execution_target_not_trusted: true,
  workspace_git_required: true,
  workspace_has_tasks: true,
  workspace_name_ambiguous: true,
  workspace_not_auto_provisioned: true,
  workspace_not_found: true,
  workspace_reference_required: true,
  workspace_worker_already_attached: true,
  workspace_worker_already_registered: true,
  workspace_worker_enrollment_claimed: true,
  workspace_worker_enrollment_expired: true,
  workspace_worker_enrollment_invalid: true,
  workspace_worker_enrollment_not_found: true,
  workspace_worker_enrollment_unavailable: true,
  workspace_worker_not_connected: true,
  workspace_worker_workspace_scoped: true,
  workspace_worktrees_disabled: true,
  workspace_exec_cwd_invalid: true,
  workspace_exec_cwd_not_found: true,
  workspace_exec_output_limit_exceeded: true,
} as const;

export type ApiDomainErrorCode = keyof typeof API_DOMAIN_ERROR_CODES;

function hasOwn<T extends object>(
  object: T,
  key: PropertyKey,
): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isApiDomainErrorCode(
  code: string,
): code is ApiDomainErrorCode {
  return hasOwn(API_DOMAIN_ERROR_CODES, code);
}

function capabilityDetails(error: DomainError): Record<string, unknown> | undefined {
  const capability = error.details["capability"];
  return typeof capability === "string" && capability.length > 0
    ? { capability }
    : undefined;
}

function diagnosticsDetails(error: DomainError): Record<string, unknown> | undefined {
  const diagnostics = error.details["diagnostics"];
  return Array.isArray(diagnostics) ? { diagnostics } : undefined;
}

function changedFilesDetails(error: DomainError): Record<string, unknown> | undefined {
  const changedFiles = error.details["changedFiles"];
  return Array.isArray(changedFiles) ? { changedFiles } : undefined;
}

function fileConflictDetails(error: DomainError): Record<string, unknown> | undefined {
  const currentFile = error.details["currentFile"];
  if (currentFile === null) {
    return { currentFile: null };
  }
  if (!isRecord(currentFile)) {
    return undefined;
  }

  const name = currentFile["name"];
  const path = currentFile["path"];
  const kind = currentFile["kind"];
  const absolutePath = currentFile["absolutePath"];
  const size = currentFile["size"];
  const modifiedAt = currentFile["modifiedAt"];
  const versionToken = currentFile["versionToken"];
  if (
    typeof name !== "string"
    || typeof path !== "string"
    || (kind !== "file" && kind !== "directory")
    || typeof absolutePath !== "string"
    || typeof size !== "number"
    || !Number.isFinite(size)
    || typeof modifiedAt !== "string"
    || typeof versionToken !== "string"
  ) {
    return undefined;
  }

  return {
    currentFile: {
      name,
      path,
      kind,
      absolutePath,
      size,
      modifiedAt,
      versionToken,
      ...(typeof currentFile["loadOnExpand"] === "boolean"
        ? { loadOnExpand: currentFile["loadOnExpand"] }
        : {}),
      ...(typeof currentFile["mimeType"] === "string"
        ? { mimeType: currentFile["mimeType"] }
        : {}),
      ...(typeof currentFile["isImage"] === "boolean"
        ? { isImage: currentFile["isImage"] }
        : {}),
    },
  };
}

function fileConflictMessage(error: DomainError): string | undefined {
  const message = error.details["publicMessage"];
  return typeof message === "string" && message.length > 0 && message.length <= 500
    ? message
    : undefined;
}

function legacyAgentMessage(error: DomainError): string | undefined {
  const message = error.message.trim();
  return message.length > 0 && message.length <= 500 ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterHeaders(error: DomainError): Record<string, string> | undefined {
  const retryAfter = error.details["retryAfter"];
  return typeof retryAfter === "string" && retryAfter.length > 0
    ? { "Retry-After": retryAfter }
    : undefined;
}

const COMMON_MAPPINGS = {
  execution_host_capability_unavailable: {
    status: 409,
    message: "The execution host does not support the requested operation.",
    extra: capabilityDetails,
  },
  execution_host_unavailable: {
    status: 404,
    message: "Execution host not found or unavailable.",
  },
  invalid_credential_token: {
    status: 400,
    message: "The credential token is invalid or expired.",
  },
  task_not_found: {
    status: 404,
    error: "not_found",
    message: "Task not found",
  },
  terminal_session_not_found: {
    status: 404,
    error: "not_found",
    message: "Terminal session not found",
  },
  workspace_git_required: {
    status: 409,
    message: "This operation requires a Git-backed workspace.",
  },
  workspace_not_found: {
    status: 404,
    error: "not_found",
    message: "Workspace not found",
  },
  workspace_worktrees_disabled: {
    status: 409,
    message: "Worktrees are disabled for this workspace.",
  },
  quick_chat_model_mismatch: {
    status: 400,
    message: "The selected quick-chat model is not available.",
  },
} satisfies Partial<Record<ApiDomainErrorCode, DomainErrorHttpPolicyEntry>>;

const POLICY_PROFILES = {
  authenticated: {
    boundary: "authenticated",
    mappings: COMMON_MAPPINGS,
  },
  agents: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      agent_already_running: {
        status: 409,
        message: "Agent already has an active run.",
        messageFromError: legacyAgentMessage,
      },
      agent_chat_not_found: {
        status: 409,
        error: "agent_run_not_ready",
        message: "Agent run chat is no longer available",
      },
      agent_code_generation_failed: {
        status: 502,
        message: "The code generation provider did not create a non-empty source file.",
        messageFromError: legacyAgentMessage,
      },
      agent_code_invalid: {
        status: 400,
        extra: diagnosticsDetails,
        message: "Agent code is invalid",
        messageFromError: legacyAgentMessage,
      },
      agent_not_found: {
        status: 404,
        message: "Agent not found",
      },
      agent_run_not_ready: {
        status: 409,
        message: "The agent run is not ready.",
        messageFromError: legacyAgentMessage,
      },
      workspace_not_found: {
        status: 404,
        error: "workspace_not_found",
        message: "Workspace not found",
        messageFromError: legacyAgentMessage,
      },
      workspace_worktrees_disabled: {
        status: 409,
        message: "Worktrees are disabled for this workspace.",
        messageFromError: legacyAgentMessage,
      },
    },
  },
  "agents-md": {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      agents_md_read_failed: {
        status: 500,
        error: "read_failed",
        message: "Failed to read AGENTS.md",
      },
      agents_md_write_failed: {
        status: 500,
        error: "write_failed",
        message: "Failed to update AGENTS.md",
      },
      workspace_not_found: {
        status: 404,
        error: "workspace_not_found",
        message: "Workspace not found",
      },
    },
  },
  chats: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      acp_connection_aborted: {
        status: 409,
        error: "connection_aborted",
        message: "The connection was aborted.",
      },
      acp_connection_timed_out: {
        status: 504,
        error: "connection_timeout",
        message: "The agent connection timed out before it became ready.",
      },
      acp_request_cancelled: {
        status: 409,
        error: "cancelled",
        message: "Chat operation was cancelled.",
      },
      acp_session_not_found: {
        status: 409,
        error: "session_not_found",
        message: "The chat session is no longer available.",
      },
      acp_ssh_authentication_failed: {
        status: 401,
        error: "ssh_authentication_failed",
        message: "SSH authentication failed.",
      },
      acp_unsupported_prompt_capability: {
        status: 422,
        error: "unsupported_prompt_capability",
        message: "The connected agent does not support embedded document attachments.",
      },
      execution_host_capability_unavailable: {
        status: 409,
        message: "This execution host does not support ACP chats.",
        extra: capabilityDetails,
      },
    },
  },
  "execution-hosts": {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      execution_host_addresses_unavailable: {
        status: 409,
        message: "Execution-host addresses are unavailable.",
      },
      execution_host_binding_stale: {
        status: 409,
        message: "Execution host configuration changed.",
      },
      execution_host_capability_unavailable: COMMON_MAPPINGS.execution_host_capability_unavailable,
      execution_host_configuration_unsupported: {
        status: 400,
        message: "This execution host must be configured through its transport settings.",
      },
      execution_host_directory_invalid: {
        status: 400,
        message: "The selected directory does not exist on the execution host.",
      },
      execution_host_exec_cwd_invalid: {
        status: 400,
        message: "The execution working directory is invalid.",
      },
      execution_host_exec_cwd_not_found: {
        status: 400,
        message: "The execution working directory was not found.",
      },
      execution_host_exec_output_limit_exceeded: {
        status: 413,
        message: "Execution output exceeded the allowed limit.",
      },
      execution_host_private: {
        status: 400,
        message: "This execution host is private to its workspace.",
      },
      mesh_control_request_rejected: {
        status: 502,
        message: "The Mesh execution host rejected the configuration update.",
      },
      mesh_control_request_unreachable: {
        status: 503,
        message: "The Mesh execution host could not be reached.",
      },
      mesh_execution_configuration_stale: {
        status: 409,
        message: "The execution-host configuration changed. Refresh and try again.",
      },
      mesh_execution_aborted: {
        status: 499,
        message: "Execution-host command was aborted.",
      },
      mesh_execution_result_too_large: {
        status: 413,
        message: "Execution output exceeded the allowed limit.",
      },
      mesh_execution_unreachable: {
        status: 502,
        message: "The execution host is unavailable.",
      },
    },
  },
  "file-explorer": {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      conflict: {
        status: 409,
        error: "file_conflict",
        message: "The file changed since it was loaded.",
        messageFromDetails: fileConflictMessage,
        extra: fileConflictDetails,
      },
      file_not_found: {
        status: 404,
        message: "File not found.",
      },
      invalid_file_name: {
        status: 400,
        message: "The file name is invalid.",
      },
      invalid_path: {
        status: 400,
        message: "The requested path is invalid.",
      },
      invalid_path_type: {
        status: 400,
        message: "The requested path has an invalid type.",
      },
      invalid_preview_type: {
        status: 400,
        message: "The requested preview type is invalid.",
      },
      invalid_start_directory_type: {
        status: 400,
        message: "The start directory has an invalid type.",
      },
      invalid_upload_state: {
        status: 400,
        message: "The upload is not in a valid state.",
      },
      operation_failed: {
        status: 500,
        message: "File explorer operation failed.",
      },
      root_not_mutable: {
        status: 400,
        message: "The file explorer root cannot be modified.",
      },
      start_directory_not_found: {
        status: 404,
        message: "The start directory was not found.",
      },
      upload_session_not_found: {
        status: 404,
        message: "The upload session was not found.",
      },
      upload_session_target_mismatch: {
        status: 400,
        message: "The upload session target does not match.",
      },
      upload_size_exceeded: {
        status: 413,
        message: "The upload exceeds the allowed size.",
      },
    },
  },
  mesh: {
    boundary: "mesh",
    mappings: {
      ...COMMON_MAPPINGS,
      mesh_acp_unavailable: {
        status: 503,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_control_request_rejected: {
        status: 502,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_control_request_unreachable: {
        status: 503,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_enrollment_controller_mismatch: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_enrollment_target_invalid: {
        status: 400,
        message: "The Mesh enrollment target is invalid.",
      },
      mesh_enrollment_discovery_invalid: {
        status: 400,
        message: "Mesh enrollment discovery is invalid.",
      },
      mesh_enrollment_discovery_too_large: {
        status: 400,
        message: "Mesh enrollment discovery is too large.",
      },
      mesh_enrollment_discovery_rejected: {
        status: 502,
        message: "Mesh enrollment discovery was rejected.",
      },
      mesh_enrollment_discovery_timeout: {
        status: 503,
        message: "Mesh enrollment discovery timed out.",
      },
      mesh_enrollment_discovery_unreachable: {
        status: 503,
        message: "Mesh enrollment discovery is unavailable.",
      },
      mesh_enrollment_expired: {
        status: 410,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_enrollment_relay_mismatch: {
        status: 409,
        message: "The Mesh relay does not match the enrollment.",
      },
      mesh_enrollment_relay_identity_invalid: {
        status: 400,
        message: "The Mesh relay identity is invalid.",
      },
      mesh_enrollment_relay_unpaired: {
        status: 409,
        message: "The Mesh relay is not paired.",
      },
      mesh_enrollment_response_invalid: {
        status: 502,
        message: "The Mesh enrollment response is invalid.",
      },
      mesh_enrollment_self: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_enrollment_token_invalid: {
        status: 410,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_peer_not_trusted: {
        status: 403,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_peer_revoked: {
        status: 403,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_relay_not_paired: {
        status: 409,
        message: "The Mesh relay is not paired.",
      },
      mesh_relay_unavailable: {
        status: 503,
        message: "The Mesh relay is unavailable.",
      },
      mesh_role_invalid: {
        status: 404,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_worker_not_found: {
        status: 404,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      mesh_worker_relay_grants_inconsistent: {
        status: 409,
        message: "Mesh worker relay grants are inconsistent.",
      },
      workspace_worker_enrollment_claimed: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_enrollment_expired: {
        status: 410,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_enrollment_not_found: {
        status: 404,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_enrollment_unavailable: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_already_attached: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_already_registered: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_enrollment_invalid: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_not_connected: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
      workspace_worker_workspace_scoped: {
        status: 409,
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
      },
    },
    unknownStatus: (code) => code.startsWith("mesh_") ? 400 : undefined,
  },
  "mesh-internal": {
    boundary: "mesh-internal",
    mappings: {
      ...COMMON_MAPPINGS,
      mesh_acp_unavailable: {
        status: 503,
        message: "Mesh ACP is unavailable.",
      },
      mesh_enrollment_controller_mismatch: {
        status: 409,
        message: "The Mesh enrollment controller does not match.",
      },
      mesh_enrollment_expired: {
        status: 410,
        message: "The Mesh enrollment has expired.",
      },
      mesh_enrollment_relay_mismatch: {
        status: 409,
        message: "The Mesh relay does not match the enrollment.",
      },
      mesh_enrollment_token_invalid: {
        status: 410,
        message: "The Mesh enrollment token is invalid or expired.",
      },
      mesh_execution_async_command_not_found: {
        status: 404,
        message: "The Mesh execution command was not found.",
      },
      mesh_execution_caller_not_active: {
        status: 409,
        message: "The Mesh execution caller is not active.",
      },
      mesh_execution_aborted: {
        status: 400,
        message: "The Mesh execution request was aborted.",
      },
      mesh_execution_cancel_failed: {
        status: 400,
        message: "The Mesh execution request could not be cancelled.",
      },
      mesh_execution_capability_unavailable: {
        status: 400,
        message: "The Mesh execution capability is unavailable.",
      },
      mesh_execution_command_failed: {
        status: 400,
        message: "The Mesh execution command failed.",
      },
      mesh_execution_configuration_request_expired: {
        status: 410,
        message: "The Mesh execution configuration request has expired.",
      },
      mesh_execution_configuration_stale: {
        status: 409,
        message: "The Mesh execution configuration is stale.",
      },
      mesh_execution_context_changed: {
        status: 409,
        message: "The Mesh execution context changed.",
      },
      mesh_execution_encryption_key_invalid: {
        status: 400,
        message: "The Mesh execution encryption key is invalid.",
      },
      mesh_execution_encryption_unavailable: {
        status: 400,
        message: "Mesh execution encryption is unavailable.",
      },
      mesh_execution_endpoint_unavailable: {
        status: 400,
        message: "The Mesh execution endpoint is unavailable.",
      },
      mesh_execution_environment_invalid: {
        status: 400,
        message: "The Mesh execution environment is invalid.",
      },
      mesh_execution_environment_unavailable: {
        status: 400,
        message: "The Mesh execution environment is unavailable.",
      },
      mesh_execution_limit_exceeded: {
        status: 400,
        message: "The Mesh execution limit was exceeded.",
      },
      mesh_execution_operation_unsupported: {
        status: 501,
        message: "The Mesh execution operation is unsupported.",
      },
      mesh_execution_output_gap: {
        status: 400,
        message: "The Mesh execution output has a gap.",
      },
      mesh_execution_output_offset_invalid: {
        status: 400,
        message: "The Mesh execution output offset is invalid.",
      },
      mesh_execution_owner_mismatch: {
        status: 403,
        message: "The Mesh execution owner does not match.",
      },
      mesh_execution_path_invalid: {
        status: 400,
        message: "The Mesh execution path is invalid.",
      },
      mesh_execution_protocol_mismatch: {
        status: 400,
        message: "The Mesh execution protocol is incompatible.",
      },
      mesh_execution_replay: {
        status: 400,
        message: "The Mesh execution request has already been used.",
      },
      mesh_execution_request_failed: {
        status: 400,
        message: "The Mesh execution request failed.",
      },
      mesh_execution_request_invalid: {
        status: 400,
        message: "The Mesh execution request is invalid.",
      },
      mesh_execution_request_too_large: {
        status: 400,
        message: "The Mesh execution request is too large.",
      },
      mesh_execution_response_invalid: {
        status: 400,
        message: "The Mesh execution response is invalid.",
      },
      mesh_execution_result_too_large: {
        status: 413,
        message: "The Mesh execution result is too large.",
      },
      mesh_execution_session_expired: {
        status: 401,
        message: "The Mesh execution session has expired.",
      },
      mesh_execution_session_expiry_invalid: {
        status: 400,
        message: "The Mesh execution session expiry is invalid.",
      },
      mesh_execution_session_invalid: {
        status: 401,
        message: "The Mesh execution session is invalid.",
      },
      mesh_execution_target_invalid: {
        status: 400,
        message: "The Mesh execution target is invalid.",
      },
      mesh_execution_unreachable: {
        status: 400,
        message: "The Mesh execution peer could not be reached.",
      },
      execution_host_directory_invalid: {
        status: 400,
        message: "The execution-host directory is invalid.",
      },
      mesh_peer_target_invalid: {
        status: 400,
        message: "The Mesh peer target is invalid.",
      },
      mesh_peer_not_trusted: {
        status: 403,
        message: "The Mesh peer is not trusted.",
      },
      mesh_peer_revoked: {
        status: 403,
        message: "The Mesh peer has been revoked.",
      },
      mesh_role_invalid: {
        status: 404,
        message: "The Mesh role is invalid.",
      },
      mesh_terminal_context_changed: {
        status: 403,
        message: "The Mesh terminal context changed.",
      },
      mesh_terminal_session_expired: {
        status: 401,
        message: "The Mesh terminal session has expired.",
      },
      mesh_terminal_session_invalid: {
        status: 401,
        message: "The Mesh terminal session is invalid.",
      },
      mesh_terminal_target_invalid: {
        status: 403,
        message: "The Mesh terminal target is invalid.",
      },
      mesh_worker_kill_expired: {
        status: 410,
        message: "The Mesh worker kill request has expired.",
      },
      mesh_worker_kill_invalid_signature: {
        status: 400,
        message: "The Mesh worker kill signature is invalid.",
      },
      workspace_not_found: {
        status: 404,
        error: "workspace_not_found",
        message: "Workspace not found.",
      },
    },
    unknownStatus: (code) =>
      code.startsWith("mesh_terminal_")
      || code.startsWith("mesh_tunnel_")
      || code.startsWith("mesh_execution_")
      || code.startsWith("mesh_peer_")
      || code.startsWith("mesh_endpoint_")
        ? 400
        : undefined,
  },
  "mesh-relay": {
    boundary: "mesh-relay",
    mappings: {
      ...COMMON_MAPPINGS,
      mesh_relay_authorization_failed: {
        status: 502,
        message: "Mesh relay authorization failed.",
      },
      mesh_relay_controller_identity_changed: {
        status: 409,
        message: "The Mesh controller identity changed.",
      },
      mesh_relay_controller_mismatch: {
        status: 409,
        message: "The Mesh relay controller does not match.",
      },
      mesh_relay_descriptor_invalid: {
        status: 502,
        message: "The Mesh relay descriptor is invalid.",
      },
      mesh_relay_descriptor_rejected: {
        status: 502,
        message: "The Mesh relay rejected the descriptor.",
      },
      mesh_relay_descriptor_too_large: {
        status: 413,
        message: "The Mesh relay descriptor is too large.",
      },
      mesh_relay_descriptor_unreachable: {
        status: 502,
        message: "The Mesh relay descriptor is unreachable.",
      },
      mesh_relay_pairing_auth_failed: {
        status: 401,
        message: "Mesh relay pairing authentication failed.",
      },
      mesh_relay_url_invalid: {
        status: 400,
        message: "The Mesh relay URL is invalid.",
      },
      mesh_role_invalid: {
        status: 404,
        message: "The Mesh role is invalid.",
      },
    },
  },
  previews: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      execution_host_capability_unavailable: {
        status: 409,
        message: "This execution host does not support direct previews.",
        extra: capabilityDetails,
      },
      execution_host_name_ambiguous: {
        status: 409,
        message: "The execution host name is ambiguous.",
      },
      execution_host_not_found: {
        status: 404,
        message: "Execution host not found.",
      },
      execution_host_private: {
        status: 409,
        message: "The execution host is private.",
      },
      execution_host_reference_required: {
        status: 400,
        message: "An execution host reference is required.",
      },
      preview_server_unsupported: {
        status: 409,
        message: "The preview server is unsupported.",
      },
      workspace_name_ambiguous: {
        status: 409,
        message: "The workspace name is ambiguous.",
      },
      workspace_reference_required: {
        status: 400,
        message: "A workspace reference is required.",
      },
    },
  },
  provisioning: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      execution_host_addresses_unavailable: {
        status: 409,
        message: "Execution-host addresses are unavailable.",
      },
      execution_host_capability_unavailable: {
        status: 409,
        message: "This execution host does not support provisioning.",
        extra: capabilityDetails,
      },
      execution_host_unavailable: {
        status: 409,
        message: "Execution host is unavailable.",
      },
      invalid_execution_target: {
        status: 400,
        message: "The execution target is invalid.",
      },
      invalid_worker_host_address: {
        status: 400,
        message: "The worker host address is invalid.",
      },
      job_not_terminal: {
        status: 409,
        message: "The provisioning job is not terminal.",
      },
      mesh_public_base_url_not_configured: {
        status: 400,
        message: "Configure CLANKY_PUBLIC_BASE_URL before using worker provisioning.",
      },
      provisioning_cancelled: {
        status: 409,
        message: "The provisioning job was cancelled.",
      },
      provisioning_target_busy: {
        status: 409,
        message: "The provisioning target is busy.",
      },
      ssh_server_not_found: {
        status: 404,
        error: "not_found",
        message: "SSH server not found",
      },
      workspace_worker_already_attached: {
        status: 409,
        message: "The workspace worker is already attached.",
      },
      workspace_worker_enrollment_claimed: {
        status: 409,
        message: "The workspace worker enrollment has already been claimed.",
      },
      workspace_worker_enrollment_expired: {
        status: 410,
        message: "The workspace worker enrollment has expired.",
      },
      workspace_worker_enrollment_not_found: {
        status: 404,
        message: "Workspace worker enrollment not found.",
      },
      workspace_worker_enrollment_unavailable: {
        status: 409,
        message: "Workspace worker enrollment is unavailable.",
      },
      workspace_worker_not_connected: {
        status: 409,
        message: "The workspace worker is not connected.",
      },
    },
  },
  ssh: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      invalid_encrypted_credential: {
        status: 400,
        message: "The encrypted credential is invalid.",
      },
      ssh_server_key_generation_failed: {
        status: 500,
        message: "Failed to generate SSH server key pair",
      },
      ssh_server_not_found: {
        status: 404,
        error: "not_found",
        message: "SSH server not found",
      },
      ssh_server_reload_failed: {
        status: 500,
        message: "Failed to reload SSH server",
      },
    },
  },
  tasks: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      automatic_pr_flow_busy: {
        status: 409,
        error: "automatic_pr_flow_busy",
        message: "Automatic PR flow is already processing feedback",
      },
      automatic_pr_flow_disabled: {
        status: 400,
        error: "automatic_pr_flow_disabled",
        message: "Automatic PR flow is not enabled for this task",
      },
      active_task_update_restricted: {
        status: 409,
        message: "Cannot update an active task. Stop it first.",
      },
      base_branch_immutable: {
        status: 409,
        message: "Base branch cannot be updated after git setup.",
      },
      directory_in_use: {
        status: 409,
        error: "directory_in_use",
        message: "The task directory is already in use",
      },
      invalid_model_config: {
        status: 400,
        error: "invalid_model_config",
        message: "Invalid model configuration",
      },
      invalid_uploaded_plan: {
        status: 400,
        message: "The uploaded plan is invalid.",
      },
      cheap_model_not_enabled: {
        status: 400,
        message: "The selected low-cost model is not available.",
      },
      invalid_task_input: {
        status: 400,
        error: "validation_error",
        message: "Invalid task input",
      },
      invalid_task_state: {
        status: 400,
        error: "invalid_state",
        message: "Task is in an invalid state for this operation",
      },
      operation_in_progress: {
        status: 409,
        error: "operation_in_progress",
        message: "This task operation is already in progress",
      },
      plan_execution_update_restricted: {
        status: 409,
        message: "After plan approval, only the fully autonomous setting can be changed while execution is still in progress.",
      },
      plan_not_ready: {
        status: 400,
        error: "plan_not_ready",
        message: "Plan is not ready yet",
      },
      model_not_enabled: {
        status: 400,
        message: "The selected model is not available.",
      },
      model_not_found: {
        status: 400,
        message: "The selected model was not found.",
      },
      provider_not_found: {
        status: 400,
        message: "The selected model provider was not found.",
      },
      validation_failed: {
        status: 400,
        message: "The selected model could not be validated.",
      },
      planning_update_restricted: {
        status: 409,
        message: "Only auto-accept plan and fully autonomous task can be changed while plan mode is running.",
      },
      task_already_running: {
        status: 409,
        error: "already_running",
        message: "Task is already running",
      },
      task_branch_missing: {
        status: 400,
        error: "no_git_branch",
        message: "No git branch was created for this task",
      },
      task_file_operation_failed: {
        status: 500,
        message: "Task file operation failed",
      },
      task_git_operation_failed: {
        status: 500,
        message: "Task git operation failed",
      },
      task_no_remote: {
        status: 400,
        error: "no_remote",
        message: "Workspace has no git remote configured",
      },
      task_not_addressable: {
        status: 400,
        error: "invalid_state",
        message: "Task cannot receive follow-up feedback",
      },
      task_not_planning: {
        status: 400,
        error: "not_planning",
        message: "Task is not in planning status",
      },
      task_not_running: {
        status: 409,
        error: "not_running",
        message: "Task is not running",
      },
      task_operation_failed: {
        status: 500,
        message: "Task operation failed",
      },
      task_session_reconnect_failed: {
        status: 500,
        message: "Task session could not be reconnected",
      },
      task_terminal_session_failed: {
        status: 500,
        message: "Task terminal session operation failed",
      },
      task_rename_restricted: {
        status: 409,
        message: "Task name can only be updated while the task is still a draft.",
      },
      task_worktree_missing: {
        status: 400,
        error: "no_worktree",
        message: "Task worktree is not available",
      },
      uncommitted_changes: {
        status: 409,
        error: "uncommitted_changes",
        message: "Cannot start because the repository has uncommitted changes",
        extra: changedFilesDetails,
      },
      use_worktree_immutable: {
        status: 409,
        message: "Use Worktree cannot be updated after git setup.",
      },
    },
  },
  terminal: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      execution_host_capability_unavailable: {
        status: 409,
        message: "This execution host does not support interactive terminals.",
        extra: capabilityDetails,
      },
      task_working_directory_unavailable: {
        status: 400,
        error: "invalid_session_configuration",
        message: "The task working directory is unavailable.",
      },
      terminal_session_not_found: {
        status: 404,
        error: "not_found",
        message: "Terminal session not found",
      },
    },
  },
  settings: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      purge_terminal_tasks_failed: {
        status: 500,
        message: "Failed to purge terminal-state tasks",
      },
      reset_failed: {
        status: 500,
        message: "Failed to reset settings",
      },
    },
  },
  transcript: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      transcript_cursor_invalid: {
        status: 400,
        error: "invalid_transcript_cursor",
        message: "The transcript cursor is invalid",
      },
    },
  },
  transport: {
    boundary: "transport",
    mappings: {
      ...COMMON_MAPPINGS,
      invalid_credential_token: {
        status: 400,
        message: "SSH credential token is missing or expired",
      },
      ssh_server_not_found: {
        status: 404,
        message: "SSH server not found",
      },
      mesh_terminal_connection_unavailable: {
        status: 503,
        message: "The Mesh terminal connection is unavailable.",
      },
      mesh_terminal_capability_mismatch: {
        status: 409,
        message: "The Mesh terminal capability does not match.",
      },
      mesh_terminal_capability_unavailable: {
        status: 503,
        message: "The Mesh terminal capability is unavailable.",
      },
      mesh_terminal_link_unavailable: {
        status: 503,
        message: "The Mesh terminal link is unavailable.",
      },
      terminal_session_not_found: {
        status: 404,
        error: "terminal_session_not_found",
        message: "Terminal session not found.",
      },
      mesh_terminal_session_expired: {
        status: 401,
        message: "The Mesh terminal session has expired.",
      },
      mesh_terminal_target_unavailable: {
        status: 503,
        message: "The Mesh terminal target is unavailable.",
      },
      terminal_connection_unavailable: {
        status: 503,
        message: "The terminal connection is unavailable.",
      },
      terminal_directory_unavailable: {
        status: 400,
        message: "The terminal directory is unavailable.",
      },
      terminal_execution_target_changed: {
        status: 409,
        message: "The terminal execution target changed.",
      },
      terminal_persistent_session_attach_unavailable: {
        status: 503,
        message: "The persistent terminal session cannot be attached.",
      },
      terminal_session_closing: {
        status: 409,
        message: "The terminal session is closing.",
      },
      terminal_target_mismatch: {
        status: 409,
        message: "The terminal target does not match.",
      },
    },
  },
  vnc: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      execution_host_capability_unavailable: {
        status: 409,
        message: "This execution host does not support VNC sessions.",
        extra: capabilityDetails,
      },
      execution_host_unavailable: {
        status: 404,
        message: "Execution host not found or unavailable.",
      },
      ssh_server_not_found: {
        status: 404,
        error: "not_found",
        message: "SSH server not found",
      },
      vnc_session_not_active: {
        status: 409,
        message: "The VNC session is not active.",
      },
      vnc_session_not_found: {
        status: 404,
        error: "not_found",
        message: "VNC session not found",
      },
      vnc_session_start_failed: {
        status: 500,
        message: "Failed to start VNC session",
      },
      vnc_tunnel_failed: {
        status: 500,
        message: "VNC tunnel failed to start",
      },
      workspace_execution_target_missing: {
        status: 409,
        message: "The workspace SSH execution target is not configured.",
      },
    },
  },
  voice: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      voice_audio_too_large: {
        status: 413,
        message: "The voice audio payload is too large.",
      },
      voice_capability_not_configured: {
        status: 409,
        message: "The voice capability is not configured.",
      },
      voice_capability_unavailable: {
        status: 409,
        message: "The voice capability is unavailable.",
      },
      voice_invalid_base_url: {
        status: 400,
        message: "The voice provider URL is invalid.",
      },
      voice_not_configured: {
        status: 409,
        message: "Voice is not configured.",
      },
      voice_provider_invalid_request: {
        status: 400,
        message: "The voice provider rejected the request.",
      },
      voice_provider_invalid_response: {
        status: 502,
        message: "The voice provider returned an invalid response.",
      },
      voice_provider_rate_limited: {
        status: 429,
        message: "The voice provider rate-limited the request.",
        headers: retryAfterHeaders,
      },
      voice_provider_redirect: {
        status: 502,
        message: "The voice provider returned an unsafe redirect.",
      },
      voice_provider_request_failed: {
        status: 502,
        message: "The voice provider request failed.",
      },
      voice_provider_response_too_large: {
        status: 502,
        message: "The voice provider response is too large.",
      },
      voice_provider_timeout: {
        status: 504,
        message: "The voice provider timed out.",
      },
      voice_provider_unreachable: {
        status: 502,
        message: "The voice provider is unavailable.",
      },
      voice_unsafe_provider_url: {
        status: 400,
        message: "The voice provider URL is unsafe.",
      },
      voice_validation_stale: {
        status: 409,
        message: "Voice validation is stale.",
      },
      voice_text_too_large: {
        status: 413,
        message: "The voice text payload is too large.",
      },
    },
  },
  workspaces: {
    boundary: "authenticated",
    mappings: {
      ...COMMON_MAPPINGS,
      directory_not_found: {
        status: 400,
        message: "Directory does not exist on the remote server.",
      },
      execution_host_capability_unavailable: COMMON_MAPPINGS.execution_host_capability_unavailable,
      execution_host_private: {
        status: 400,
        message: "This execution host is private to its workspace.",
      },
      execution_host_unavailable: {
        status: 400,
        message: "Execution host is unavailable.",
      },
      workspace_not_found: {
        status: 404,
        error: "workspace_not_found",
        message: "Workspace not found",
      },
      mesh_execution_aborted: {
        status: 499,
        message: "Workspace command was aborted",
      },
      mesh_execution_unreachable: {
        status: 502,
        message: "Workspace execution host is unavailable",
      },
      invalid_credential_token: {
        status: 400,
        message: "SSH credential token is missing or expired",
      },
      not_git_repo: {
        status: 400,
        message: "Directory must be a git repository.",
      },
      validation_failed: {
        status: 400,
        message: "Failed to validate the workspace directory.",
      },
      workspace_delete_metadata_invalid: {
        status: 400,
        message: "Workspace deletion metadata is invalid.",
      },
      workspace_delete_remote_failed: {
        status: 500,
        message: "Failed to delete the auto-provisioned workspace directory",
      },
      workspace_deletion_in_progress: {
        status: 409,
        message: "Workspace deletion is already in progress.",
      },
      workspace_execution_target_in_use: {
        status: 409,
        message: "The workspace execution target is already in use.",
      },
      workspace_execution_target_not_trusted: {
        status: 400,
        message: "The workspace execution target is not trusted.",
      },
      workspace_worker_already_attached: {
        status: 409,
        message: "The workspace worker is already attached.",
      },
      workspace_worker_enrollment_claimed: {
        status: 409,
        message: "The workspace worker enrollment has already been claimed.",
      },
      workspace_worker_enrollment_expired: {
        status: 410,
        message: "The workspace worker enrollment has expired.",
      },
      workspace_worker_enrollment_not_found: {
        status: 404,
        message: "Workspace worker enrollment not found.",
      },
      workspace_worker_enrollment_unavailable: {
        status: 409,
        message: "Workspace worker enrollment is unavailable.",
      },
      workspace_worker_not_connected: {
        status: 409,
        message: "The workspace worker is not connected.",
      },
      workspace_exec_cwd_invalid: {
        status: 400,
        message: "The workspace execution working directory is invalid.",
      },
      workspace_exec_cwd_not_found: {
        status: 400,
        message: "The workspace execution working directory was not found.",
      },
      workspace_exec_output_limit_exceeded: {
        status: 413,
        message: "Workspace command output exceeded the allowed limit.",
      },
      workspace_has_tasks: {
        status: 400,
        message: "The workspace still has tasks.",
      },
      workspace_not_auto_provisioned: {
        status: 400,
        message: "The workspace was not auto-provisioned.",
      },
    },
  },
} satisfies Record<DomainErrorPolicyName, DomainErrorPolicyProfile>;

function getPolicyProfile(
  policy: DomainErrorPolicyName,
): DomainErrorPolicyProfile {
  return POLICY_PROFILES[policy];
}

function getEntryMapping(
  entry: DomainErrorHttpPolicyEntry,
  error: DomainError,
): DomainErrorHttpMapping {
  const message = entry.messageFromDetails?.(error)
    ?? entry.messageFromError?.(error)
    ?? entry.message;
  return {
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    ...(message ? { message } : {}),
    ...(entry.extra ? { extra: entry.extra(error) } : {}),
    ...(entry.headers ? { headers: entry.headers(error) } : {}),
  };
}

export function resolveDomainErrorHttpMapping(
  error: unknown,
  options: {
    fallback: { message: string };
    mappings?: Readonly<Record<string, DomainErrorHttpMapping>>;
    policy?: DomainErrorPolicyName;
  },
): DomainErrorHttpMapping | null {
  if (!isDomainError(error)) {
    return null;
  }

  const policy = getPolicyProfile(options.policy ?? "authenticated");
  const mapping = isApiDomainErrorCode(error.code)
    ? policy.mappings[error.code]
    : undefined;
  const override = options.mappings?.[error.code];
  if (!mapping && !override) {
    return null;
  }

  const resolved = mapping
    ? getEntryMapping(mapping, error)
    : { status: override!.status };
  const safeMessage = resolved.message
    ?? (mapping?.message ?? options.fallback.message);

  return {
    ...resolved,
    message: safeMessage,
    ...(override?.error ? { error: override.error } : {}),
    ...(override?.message ? { message: override.message } : {}),
    ...(override?.extra ? { extra: override.extra } : {}),
    ...(override?.headers ? { headers: override.headers } : {}),
    error: override?.error ?? resolved.error ?? error.code,
  };
}

export function getUnknownDomainErrorStatus(
  error: unknown,
  options: {
    fallbackStatus: number;
    policy?: DomainErrorPolicyName;
  },
): number {
  if (!isDomainError(error)) {
    return options.fallbackStatus;
  }
  const profile = getPolicyProfile(options.policy ?? "authenticated");
  return profile.unknownStatus?.(error.code) ?? options.fallbackStatus;
}

export function getSafeDomainErrorMessage(
  code: string,
  fallback: string,
  policy: DomainErrorPolicyName = "authenticated",
): string {
  if (!isApiDomainErrorCode(code)) {
    return fallback;
  }
  return getPolicyProfile(policy).mappings[code]?.message ?? fallback;
}

export function getDomainErrorPolicyBoundary(
  policy: DomainErrorPolicyName = "authenticated",
): DomainErrorBoundary {
  return getPolicyProfile(policy).boundary;
}
