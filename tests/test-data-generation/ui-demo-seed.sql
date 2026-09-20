-- Demo-only UI seed for the consolidated schema.
--
-- Every application-owned row uses the demo-* namespace so this fixture can
-- be applied to a disposable database or to a developer database without
-- deleting unrelated records. The cleanup is intentionally explicit because
-- several tables are not connected to webapp_users by a foreign key.

PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;

-- Remove only rows owned by this fixture, in child-to-parent order.
DELETE FROM provisioning_job_logs WHERE job_id LIKE 'demo-%';
DELETE FROM task_transcript_entries WHERE task_id LIKE 'demo-%';
DELETE FROM task_transcript_meta WHERE task_id LIKE 'demo-%';
DELETE FROM chat_transcript_entries WHERE chat_id LIKE 'demo-%';
DELETE FROM chat_transcript_meta WHERE chat_id LIKE 'demo-%';
DELETE FROM agent_run_transcript_entries WHERE agent_run_id LIKE 'demo-%';
DELETE FROM agent_run_transcript_meta WHERE agent_run_id LIKE 'demo-%';
DELETE FROM review_comments WHERE id LIKE 'demo-%' OR task_id LIKE 'demo-%';
DELETE FROM agent_runs WHERE id LIKE 'demo-%' OR agent_id LIKE 'demo-%';
DELETE FROM provisioning_jobs WHERE id LIKE 'demo-%';
DELETE FROM terminal_sessions WHERE id LIKE 'demo-%';
DELETE FROM preview_sessions WHERE id LIKE 'demo-%';
DELETE FROM chats WHERE id LIKE 'demo-%';
DELETE FROM agents WHERE id LIKE 'demo-%';
DELETE FROM tasks WHERE id LIKE 'demo-%';
DELETE FROM sessions WHERE task_id LIKE 'demo-%';
DELETE FROM clanky_context_api_keys
WHERE api_key_id LIKE 'demo-%' OR context_id LIKE 'demo-%';
DELETE FROM workspace_execution_targets WHERE workspace_id LIKE 'demo-%';
DELETE FROM workspace_worker_enrollments
WHERE id LIKE 'demo-%' OR token_id LIKE 'demo-%' OR workspace_id LIKE 'demo-%';
DELETE FROM workspaces WHERE id LIKE 'demo-%';
DELETE FROM mesh_enrollment_tokens WHERE id LIKE 'demo-%' OR user_id = 'demo-user';
DELETE FROM mesh_worker_registrations
WHERE local_user_id = 'demo-user' AND worker_node_id LIKE 'demo-%';
DELETE FROM mesh_controller_grants WHERE controller_node_id LIKE 'demo-%';
DELETE FROM mesh_worker_kill_nonces WHERE nonce LIKE 'demo-%';
DELETE FROM execution_hosts WHERE id LIKE 'demo-%';
DELETE FROM ssh_servers WHERE id LIKE 'demo-%';
DELETE FROM preferences WHERE user_id = 'demo-user';
DELETE FROM mesh_node_identity WHERE node_id LIKE 'demo-%';
DELETE FROM mesh_controller_relay_pairing WHERE relay_url LIKE 'http://demo-%';
DELETE FROM webapp_users WHERE id = 'demo-user';

INSERT INTO webapp_users (
  id, username, role, auth_version, created_at, updated_at, last_login_at, disabled_at
) VALUES (
  'demo-user', 'demo', 'owner', 1,
  '2026-04-16T18:00:00.000Z', '2026-04-17T14:00:00.000Z',
  '2026-04-17T13:55:00.000Z', NULL
)
ON CONFLICT(id) DO UPDATE SET
  username = excluded.username,
  role = excluded.role,
  auth_version = excluded.auth_version,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  last_login_at = excluded.last_login_at,
  disabled_at = excluded.disabled_at;

INSERT INTO preferences (key, user_id, value) VALUES
  ('last-model', 'demo-user', '{"providerID":"copilot","modelID":"gpt-5.2","variant":""}'),
  ('last-cheap-model', 'demo-user', '{"providerID":"copilot","modelID":"gpt-5-mini","variant":""}'),
  ('last-directory', 'demo-user', '/workspaces/demo-storefront'),
  ('dashboard-view-mode', 'demo-user', '"cards"'),
  ('markdown-rendering', 'demo-user', '"rich"'),
  ('file-explorer-full-tree', 'demo-user', 'true'),
  ('quick-chat', 'demo-user', '{"providerID":"copilot","modelID":"gpt-5.2","variant":"","autoApprovePermissions":false}'),
  ('new-task-planning', 'demo-user', '{"planMode":true,"autoAcceptPlan":false}')
ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value;

INSERT INTO ssh_servers (
  id, user_id, name, address, username, created_at, updated_at,
  repositories_base_path, is_private, port
) VALUES
  (
    'demo-server-build', 'demo-user', 'Build Box', 'build.demo.internal', 'clanky',
    '2026-04-16T18:00:00.000Z', '2026-04-17T13:40:00.000Z',
    '/srv/workspaces', 0, 22
  ),
  (
    'demo-server-ops', 'demo-user', 'Operations Box', 'ops.demo.internal', 'deploy',
    '2026-04-16T18:05:00.000Z', '2026-04-17T12:10:00.000Z',
    '/opt/projects', 1, 2202
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  address = excluded.address,
  username = excluded.username,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  repositories_base_path = excluded.repositories_base_path,
  is_private = excluded.is_private,
  port = excluded.port;

INSERT INTO execution_hosts (
  id, user_id, kind, source_id, target_key, revision, revoked_at,
  created_at, updated_at, platform_os, platform_architecture, capabilities_json
) VALUES
  (
    'demo-host-local', 'demo-user', 'local', 'demo-local-node', 'demo-target-local', 1, NULL,
    '2026-04-16T18:00:00.000Z', '2026-04-17T13:50:00.000Z', 'linux', 'x86_64',
    '{"commandExecution":1,"fileOperations":2,"git":2,"managedWorktrees":2,"acpRuntime":2,"interactiveTerminal":1,"provisioning":1,"devboxLifecycle":1,"tcpTunnel":1,"serverHealth":1}'
  ),
  (
    'demo-host-ssh', 'demo-user', 'ssh', 'demo-server-build', 'demo-target-ssh', 3, NULL,
    '2026-04-16T18:01:00.000Z', '2026-04-17T13:45:00.000Z', 'linux', 'x86_64',
    '{"commandExecution":1,"fileOperations":2,"git":2,"managedWorktrees":2,"acpRuntime":2,"interactiveTerminal":1,"provisioning":1,"devboxLifecycle":1,"tcpTunnel":1,"serverHealth":1}'
  ),
  (
    'demo-host-mesh', 'demo-user', 'mesh', 'demo-worker-node', 'demo-target-mesh', 2, NULL,
    '2026-04-16T18:02:00.000Z', '2026-04-17T13:48:00.000Z', 'linux', 'aarch64',
    '{"commandExecution":1,"fileOperations":2,"git":2,"managedWorktrees":2,"acpRuntime":2,"interactiveTerminal":1,"tcpTunnel":1,"serverHealth":1}'
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  kind = excluded.kind,
  source_id = excluded.source_id,
  target_key = excluded.target_key,
  revision = excluded.revision,
  revoked_at = excluded.revoked_at,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  platform_os = excluded.platform_os,
  platform_architecture = excluded.platform_architecture,
  capabilities_json = excluded.capabilities_json;

-- Mesh identity and relay pairing are runtime singletons. Never seed fake
-- private or paired identities; the server creates or preserves the real
-- local identity. Controller grants below still provide representative Mesh
-- state for the UI.
INSERT INTO mesh_controller_grants (
  controller_node_id, controller_instance_name, controller_public_key,
  controller_fingerprint, controller_encryption_public_key, grant_status,
  created_at, updated_at, controller_endpoint, route_kind, relay_url, relay_fingerprint
) VALUES (
  'demo-controller-node', 'Demo Clanky Controller', 'demo-controller-public-key',
  'SHA256:demo-controller', 'demo-controller-encryption-key', 'active',
  '2026-04-16T18:00:00.000Z', '2026-04-17T13:45:00.000Z',
  'https://clanky.demo.internal', 'relay',
  'https://relay.demo.internal', 'SHA256:demo-relay'
)
ON CONFLICT(controller_node_id) DO UPDATE SET
  controller_instance_name = excluded.controller_instance_name,
  controller_public_key = excluded.controller_public_key,
  controller_fingerprint = excluded.controller_fingerprint,
  controller_encryption_public_key = excluded.controller_encryption_public_key,
  grant_status = excluded.grant_status,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  controller_endpoint = excluded.controller_endpoint,
  route_kind = excluded.route_kind,
  relay_url = excluded.relay_url,
  relay_fingerprint = excluded.relay_fingerprint;

INSERT INTO mesh_enrollment_tokens (
  id, user_id, token_hash, name, controller_node_id, controller_fingerprint,
  purpose, workspace_worker_enrollment_id, created_at, expires_at, consumed_at
) VALUES (
  'demo-enrollment-token', 'demo-user', 'sha256:demo-enrollment-token',
  'Demo workspace worker', 'demo-controller-node', 'SHA256:demo-controller',
  'workspace_worker', 'demo-worker-enrollment',
  '2026-04-17T12:00:00.000Z', '2026-04-18T12:00:00.000Z', NULL
)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  token_hash = excluded.token_hash,
  name = excluded.name,
  controller_node_id = excluded.controller_node_id,
  controller_fingerprint = excluded.controller_fingerprint,
  purpose = excluded.purpose,
  workspace_worker_enrollment_id = excluded.workspace_worker_enrollment_id,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  consumed_at = excluded.consumed_at;

INSERT INTO mesh_worker_registrations (
  worker_node_id, local_user_id, worker_instance_name, worker_endpoint,
  worker_transport, worker_public_key, worker_fingerprint,
  worker_encryption_public_key, worker_directory, worker_capabilities_json,
  worker_accept_remote_execution, worker_config_revision, registration_scope,
  workspace_worker_enrollment_id, workspace_id, grant_status, last_seen_at,
  created_at, updated_at, worker_tls_certificate, worker_tls_fingerprint,
  route_kind, relay_url, relay_fingerprint, worker_platform_os, worker_platform_architecture
) VALUES (
  'demo-worker-node', 'demo-user', 'Demo Mesh Worker', 'https://mesh.demo.internal',
  'https', 'demo-worker-public-key', 'SHA256:demo-worker',
  'demo-worker-encryption-key', '/srv/mesh',
  '{"shell":true,"git":true,"docker":true}',
  1, 4, 'global', NULL, NULL, 'active', '2026-04-17T13:49:00.000Z',
  '2026-04-16T18:00:00.000Z', '2026-04-17T13:49:00.000Z',
  'demo-tls-certificate', 'SHA256:demo-worker-tls',
  'relay', 'https://relay.demo.internal', 'SHA256:demo-relay', 'linux', 'aarch64'
)
ON CONFLICT(local_user_id, worker_node_id) DO UPDATE SET
  worker_instance_name = excluded.worker_instance_name,
  worker_endpoint = excluded.worker_endpoint,
  worker_transport = excluded.worker_transport,
  worker_public_key = excluded.worker_public_key,
  worker_fingerprint = excluded.worker_fingerprint,
  worker_encryption_public_key = excluded.worker_encryption_public_key,
  worker_directory = excluded.worker_directory,
  worker_capabilities_json = excluded.worker_capabilities_json,
  worker_accept_remote_execution = excluded.worker_accept_remote_execution,
  worker_config_revision = excluded.worker_config_revision,
  registration_scope = excluded.registration_scope,
  workspace_worker_enrollment_id = excluded.workspace_worker_enrollment_id,
  workspace_id = excluded.workspace_id,
  grant_status = excluded.grant_status,
  last_seen_at = excluded.last_seen_at,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  worker_tls_certificate = excluded.worker_tls_certificate,
  worker_tls_fingerprint = excluded.worker_tls_fingerprint,
  route_kind = excluded.route_kind,
  relay_url = excluded.relay_url,
  relay_fingerprint = excluded.relay_fingerprint,
  worker_platform_os = excluded.worker_platform_os,
  worker_platform_architecture = excluded.worker_platform_architecture;

INSERT INTO mesh_worker_kill_nonces (nonce, expires_at) VALUES
  ('demo-kill-nonce', '2026-04-18T12:00:00.000Z')
ON CONFLICT(nonce) DO UPDATE SET expires_at = excluded.expires_at;

INSERT INTO workspace_worker_enrollments (
  id, user_id, token_id, name, status, worker_node_id, workspace_id,
  claimed_by, error_code, error_message, created_at, expires_at,
  connected_at, attached_at, updated_at
) VALUES (
  'demo-worker-enrollment', 'demo-user', 'demo-enrollment-token',
  'Mesh worker for Analytics Lab', 'attached', 'demo-worker-node',
  'demo-workspace-mesh', 'demo-user', NULL, NULL,
  '2026-04-17T12:00:00.000Z', '2026-04-18T12:00:00.000Z',
  '2026-04-17T12:02:00.000Z', '2026-04-17T12:05:00.000Z',
  '2026-04-17T13:49:00.000Z'
)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  token_id = excluded.token_id,
  name = excluded.name,
  status = excluded.status,
  worker_node_id = excluded.worker_node_id,
  workspace_id = excluded.workspace_id,
  claimed_by = excluded.claimed_by,
  error_code = excluded.error_code,
  error_message = excluded.error_message,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  connected_at = excluded.connected_at,
  attached_at = excluded.attached_at,
  updated_at = excluded.updated_at;

INSERT INTO workspaces (
  id, user_id, name, directory, workspace_type, execution_target_revision,
  execution_host_id, execution_host_revision, server_settings, created_at, updated_at,
  is_private, archived, allow_clanky_context, source_directory, repo_url, base_path,
  devcontainer_subpath, provisioning_host_id, provisioning_host_revision, allow_worktrees
) VALUES
  (
    'demo-workspace-local', 'demo-user', 'Storefront Web', '/workspaces/demo-storefront',
    'git', 2, 'demo-host-local', 1, '{"agent":{"provider":"opencode"}}',
    '2026-04-16T17:50:00.000Z', '2026-04-17T13:30:00.000Z',
    0, 0, 1, NULL, 'https://github.com/example/demo-storefront', NULL, NULL, NULL, NULL, 1
  ),
  (
    'demo-workspace-remote', 'demo-user', 'Billing API', '/srv/workspaces/billing-api',
    'git', 4, 'demo-host-ssh', 3, '{"agent":{"provider":"copilot"}}',
    '2026-04-16T17:55:00.000Z', '2026-04-17T13:35:00.000Z',
    0, 0, 1, '/srv/workspaces', 'https://github.com/example/billing-api',
    '/srv/workspaces', '.devcontainer/api', 'demo-host-ssh', 3, 1
  ),
  (
    'demo-workspace-mesh', 'demo-user', 'Analytics Lab', '/srv/mesh/analytics-lab',
    'directory', 3, 'demo-host-mesh', 2, '{"agent":{"provider":"codex"}}',
    '2026-04-17T09:00:00.000Z', '2026-04-17T13:42:00.000Z',
    1, 0, 0, '/srv/mesh', NULL, '/srv/mesh', NULL, 'demo-host-mesh', 2, 0
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  directory = excluded.directory,
  workspace_type = excluded.workspace_type,
  execution_target_revision = excluded.execution_target_revision,
  execution_host_id = excluded.execution_host_id,
  execution_host_revision = excluded.execution_host_revision,
  server_settings = excluded.server_settings,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  is_private = excluded.is_private,
  archived = excluded.archived,
  allow_clanky_context = excluded.allow_clanky_context,
  source_directory = excluded.source_directory,
  repo_url = excluded.repo_url,
  base_path = excluded.base_path,
  devcontainer_subpath = excluded.devcontainer_subpath,
  provisioning_host_id = excluded.provisioning_host_id,
  provisioning_host_revision = excluded.provisioning_host_revision,
  allow_worktrees = excluded.allow_worktrees;

INSERT INTO workspace_execution_targets (
  workspace_id, user_id, host, port, username, password_ciphertext,
  target_key, revision, created_at, updated_at
) VALUES (
  'demo-workspace-remote', 'demo-user', 'build.demo.internal', 22, 'clanky',
  'demo-encrypted-password', 'demo-target-ssh', 3,
  '2026-04-16T17:55:00.000Z', '2026-04-17T13:35:00.000Z'
)
ON CONFLICT(workspace_id) DO UPDATE SET
  user_id = excluded.user_id,
  host = excluded.host,
  port = excluded.port,
  username = excluded.username,
  password_ciphertext = excluded.password_ciphertext,
  target_key = excluded.target_key,
  revision = excluded.revision,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

INSERT INTO tasks (
  id, user_id, name, directory, prompt, issue_number, created_at, updated_at, is_private,
  workspace_id, model_provider_id, model_model_id, model_variant, cheap_model,
  max_iterations, max_consecutive_errors, activity_timeout_seconds, stop_pattern,
  git_branch_prefix, git_commit_scope, base_branch, use_worktree, clear_planning_folder,
  plan_mode, plan_mode_auto_reply, auto_accept_plan, fully_autonomous, status,
  current_iteration, started_at, completed_at, last_activity_at, session_id,
  session_server_url, error_message, error_iteration, error_timestamp,
  git_original_branch, git_working_branch, git_worktree_path, git_commits,
  recent_iterations, consecutive_errors, pending_prompt, pending_prompt_mode,
  pending_model_provider_id, pending_model_model_id, pending_model_variant,
  plan_mode_active, plan_session_id, plan_server_url, plan_feedback_rounds,
  plan_content, planning_folder_cleared, plan_is_ready, pending_plan_question,
  review_mode, pull_request_monitoring, automatic_pr_flow, fully_autonomous_pending, mode
) VALUES
  (
    'demo-task-planning', 'demo-user', 'Design dashboard filters',
    '/workspaces/demo-storefront', 'Add saved filters and keyboard navigation to the dashboard.',
    184, '2026-04-16T18:20:00.000Z', '2026-04-17T13:20:00.000Z', 0,
    'demo-workspace-local', 'copilot', 'gpt-5.2', '', '{"mode":"custom","model":{"providerID":"copilot","modelID":"gpt-5-mini","variant":""}}',
    12, 3, 900, 'TASK_COMPLETE', 'feature/', 'clanky', 'main', 1, 0,
    1, 0, 0, 0, 'planning', 2, '2026-04-17T12:30:00.000Z', NULL,
    '2026-04-17T13:20:00.000Z', 'demo-session-planning', 'http://127.0.0.1:4301',
    NULL, NULL, NULL, 'main', 'feature/demo-dashboard-filters',
    '/workspaces/demo-storefront/.clanky-worktrees/demo-task-planning',
    '[]', '[{"iteration":1,"status":"completed"},{"iteration":2,"status":"waiting"}]',
    NULL, NULL, NULL, NULL, NULL, NULL,
    1, 'demo-plan-session', 'http://127.0.0.1:4301', 1,
    '# Dashboard filters\n\n- [ ] Filter by owner\n- [ ] Persist selected filters\n- [ ] Add keyboard shortcuts',
    0, 1, 'Should the filter state be shared across team members?',
    '{"enabled":true,"cycle":1}', NULL, NULL, 0, 'task'
  ),
  (
    'demo-task-running', 'demo-user', 'Refresh billing webhooks',
    '/srv/workspaces/billing-api', 'Update webhook retries and add idempotency coverage.',
    0, '2026-04-17T10:00:00.000Z', '2026-04-17T13:49:00.000Z', 0,
    'demo-workspace-remote', 'copilot', 'gpt-5.2', 'fast',
    '{"mode":"custom","model":{"providerID":"copilot","modelID":"gpt-5-mini","variant":""}}',
    20, 5, 600, 'TASK_COMPLETE', 'fix/', 'clanky', 'main', 1, 1,
    0, 1, 0, 1, 'planning', 4, '2026-04-17T12:20:00.000Z', NULL,
    '2026-04-17T13:49:00.000Z', 'demo-session-running', 'http://127.0.0.1:4302',
    NULL, NULL, NULL, 'main', 'fix/demo-webhook-retries',
    '/srv/workspaces/billing-api/.clanky-worktrees/demo-task-running',
    '[]', '[{"iteration":1,"status":"completed"},{"iteration":2,"status":"completed"},{"iteration":3,"status":"completed"}]',
    '{"lastErrorMessage":"Rate limit recovered","lastErrorCode":"provider_rate_limit","count":1}',
    NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, NULL, 0, 0, NULL,
    NULL, '{"status":"open","number":92}', '{"status":"monitoring","cycle":1}',
    0, 'task'
  ),
  (
    'demo-task-completed', 'demo-user', 'Add audit event filters',
    '/workspaces/demo-storefront', 'Add date and actor filters to the audit event table.',
    0, '2026-04-15T09:00:00.000Z', '2026-04-16T16:30:00.000Z', 0,
    'demo-workspace-local', 'openai', 'gpt-5.2', '',
    '{"mode":"custom","model":{"providerID":"openai","modelID":"gpt-5-mini","variant":""}}',
    10, 3, 900, 'TASK_COMPLETE', 'feature/', 'clanky', 'main', 1, 0,
    0, 1, 1, 0, 'completed', 6, '2026-04-15T09:15:00.000Z',
    '2026-04-16T16:30:00.000Z', '2026-04-16T16:29:00.000Z',
    'demo-session-completed', 'http://127.0.0.1:4301', NULL, NULL, NULL,
    'main', 'feature/demo-audit-filters',
    '/workspaces/demo-storefront/.clanky-worktrees/demo-task-completed',
    '[{"hash":"abc1234","message":"Add audit filters"}]',
    '[{"iteration":1,"status":"completed"},{"iteration":2,"status":"completed"}]',
    NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, NULL, 1, 1, NULL,
    '{"enabled":true,"cycle":1}', '{"status":"merged","number":88}',
    '{"status":"completed","cycle":1}', 0, 'task'
  ),
  (
    'demo-task-failed', 'demo-user', 'Repair preview health check',
    '/srv/mesh/analytics-lab', 'Investigate why the preview health check fails on ARM workers.',
    0, '2026-04-17T08:30:00.000Z', '2026-04-17T11:42:00.000Z', 1,
    'demo-workspace-mesh', 'codex', 'gpt-5.2', '',
    '{"mode":"custom","model":{"providerID":"codex","modelID":"gpt-5-mini","variant":""}}',
    8, 2, 300, 'TASK_COMPLETE', 'bugfix/', 'clanky', 'main', 0, 0,
    0, 1, 0, 0, 'failed', 3, '2026-04-17T10:30:00.000Z', NULL,
    '2026-04-17T11:42:00.000Z', NULL, NULL,
    'Mesh worker lost connection while collecting port diagnostics.', 3,
    '2026-04-17T11:42:00.000Z', 'main', 'bugfix/demo-preview-health', NULL, '[]',
    '[{"iteration":1,"status":"completed"},{"iteration":2,"status":"failed"}]',
    '{"lastErrorMessage":"Mesh worker lost connection","lastErrorCode":"mesh_disconnected","count":2}',
    NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, NULL, 0, 0, NULL,
    '{"enabled":true,"cycle":1}', '{"status":"error","number":0}',
    '{"status":"error","cycle":1}', 0, 'task'
  ),
  (
    'demo-task-draft', 'demo-user', 'Plan mobile navigation polish',
    '/workspaces/demo-storefront', 'Prepare a short plan for improving the mobile navigation.',
    0, '2026-04-17T13:00:00.000Z', '2026-04-17T13:00:00.000Z', 0,
    'demo-workspace-local', 'claude', 'claude-sonnet', '',
    '{"mode":"custom","model":{"providerID":"claude","modelID":"claude-haiku","variant":""}}',
    NULL, NULL, 900, 'TASK_COMPLETE', 'chore/', 'clanky', 'main', 1, 0,
    0, 1, 0, 0, 'draft', 0, NULL, NULL, '2026-04-17T13:00:00.000Z',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL,
    NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, NULL, 0, 0, NULL, NULL, NULL, NULL, 0,
    'task'
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  directory = excluded.directory,
  prompt = excluded.prompt,
  issue_number = excluded.issue_number,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  is_private = excluded.is_private,
  workspace_id = excluded.workspace_id,
  model_provider_id = excluded.model_provider_id,
  model_model_id = excluded.model_model_id,
  model_variant = excluded.model_variant,
  cheap_model = excluded.cheap_model,
  max_iterations = excluded.max_iterations,
  max_consecutive_errors = excluded.max_consecutive_errors,
  activity_timeout_seconds = excluded.activity_timeout_seconds,
  stop_pattern = excluded.stop_pattern,
  git_branch_prefix = excluded.git_branch_prefix,
  git_commit_scope = excluded.git_commit_scope,
  base_branch = excluded.base_branch,
  use_worktree = excluded.use_worktree,
  clear_planning_folder = excluded.clear_planning_folder,
  plan_mode = excluded.plan_mode,
  plan_mode_auto_reply = excluded.plan_mode_auto_reply,
  auto_accept_plan = excluded.auto_accept_plan,
  fully_autonomous = excluded.fully_autonomous,
  status = excluded.status,
  current_iteration = excluded.current_iteration,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at,
  last_activity_at = excluded.last_activity_at,
  session_id = excluded.session_id,
  session_server_url = excluded.session_server_url,
  error_message = excluded.error_message,
  error_iteration = excluded.error_iteration,
  error_timestamp = excluded.error_timestamp,
  git_original_branch = excluded.git_original_branch,
  git_working_branch = excluded.git_working_branch,
  git_worktree_path = excluded.git_worktree_path,
  git_commits = excluded.git_commits,
  recent_iterations = excluded.recent_iterations,
  consecutive_errors = excluded.consecutive_errors,
  pending_prompt = excluded.pending_prompt,
  pending_prompt_mode = excluded.pending_prompt_mode,
  pending_model_provider_id = excluded.pending_model_provider_id,
  pending_model_model_id = excluded.pending_model_model_id,
  pending_model_variant = excluded.pending_model_variant,
  plan_mode_active = excluded.plan_mode_active,
  plan_session_id = excluded.plan_session_id,
  plan_server_url = excluded.plan_server_url,
  plan_feedback_rounds = excluded.plan_feedback_rounds,
  plan_content = excluded.plan_content,
  planning_folder_cleared = excluded.planning_folder_cleared,
  plan_is_ready = excluded.plan_is_ready,
  pending_plan_question = excluded.pending_plan_question,
  review_mode = excluded.review_mode,
  pull_request_monitoring = excluded.pull_request_monitoring,
  automatic_pr_flow = excluded.automatic_pr_flow,
  fully_autonomous_pending = excluded.fully_autonomous_pending,
  mode = excluded.mode;

INSERT INTO sessions (
  backend_name, task_id, session_id, server_url, created_at
) VALUES
  ('copilot', 'demo-task-planning', 'demo-session-planning', 'http://127.0.0.1:4301', '2026-04-17T12:30:00.000Z'),
  ('copilot', 'demo-task-running', 'demo-session-running', 'http://127.0.0.1:4302', '2026-04-17T12:20:00.000Z'),
  ('openai', 'demo-task-completed', 'demo-session-completed', 'http://127.0.0.1:4301', '2026-04-15T09:15:00.000Z')
ON CONFLICT(backend_name, task_id) DO UPDATE SET
  session_id = excluded.session_id,
  server_url = excluded.server_url,
  created_at = excluded.created_at;

INSERT INTO chats (
  id, user_id, name, source_kind, workspace_id, scope, task_id, directory,
  created_at, updated_at, is_private, model_provider_id, model_model_id, model_variant,
  use_worktree, auto_approve_permissions, skip_base_branch_sync, base_branch, mode,
  status, started_at, completed_at, last_activity_at, session_id, session_server_url,
  error_message, error_timestamp, error_code, worktree_original_branch,
  worktree_working_branch, worktree_path, pending_permission_requests,
  queued_messages, active_message_id, interrupt_requested, connection_status,
  startup_stage, execution_host_id, execution_host_revision
) VALUES
  (
    'demo-chat-storefront', 'demo-user', 'Storefront pairing session', 'workspace',
    'demo-workspace-local', 'workspace', 'demo-task-running', '/workspaces/demo-storefront',
    '2026-04-17T12:40:00.000Z', '2026-04-17T13:49:00.000Z', 0,
    'copilot', 'gpt-5.2', '', 1, 0, 0, 'main', 'chat', 'idle',
    '2026-04-17T12:40:00.000Z', NULL, '2026-04-17T13:49:00.000Z',
    'demo-chat-session-storefront', 'http://127.0.0.1:4301', NULL, NULL, NULL,
    'main', 'chat/demo-storefront', '/workspaces/demo-storefront/.clanky-chats/demo-chat-storefront',
    '[{"requestId":"demo-permission-1","sessionId":"demo-chat-session-storefront","permission":"run_command","patterns":["bun test"],"status":"pending","createdAt":"2026-04-17T13:48:00.000Z"}]',
    '[{"id":"demo-queued-message","content":"Can you summarize the failing test?","createdAt":"2026-04-17T13:49:00.000Z"}]',
    'demo-message-active', 0, 'disconnected', NULL, 'demo-host-local', 1
  ),
  (
    'demo-chat-host', 'demo-user', 'Direct Mesh host chat', 'execution_host',
    NULL, 'workspace', NULL, '/srv/mesh/analytics-lab',
    '2026-04-17T09:30:00.000Z', '2026-04-17T11:45:00.000Z', 1,
    'codex', 'gpt-5.2', '', 0, 1, 1, NULL, 'chat', 'done',
    '2026-04-17T09:30:00.000Z', '2026-04-17T11:45:00.000Z', '2026-04-17T11:44:00.000Z',
    'demo-chat-session-host', 'http://127.0.0.1:4303', NULL, NULL, NULL,
    NULL, NULL, NULL, '[]', '[]', NULL, 0, 'disconnected', NULL, 'demo-host-mesh', 2
  ),
  (
    'demo-chat-ops', 'demo-user', 'Operations incident triage', 'workspace',
    'demo-workspace-remote', 'workspace', NULL, '/srv/workspaces/billing-api',
    '2026-04-17T11:00:00.000Z', '2026-04-17T11:18:00.000Z', 0,
    'copilot', 'gpt-5.2', 'fast', 0, 1, 0, 'main', 'chat', 'failed',
    '2026-04-17T11:00:00.000Z', '2026-04-17T11:18:00.000Z', '2026-04-17T11:18:00.000Z',
    NULL, NULL, 'The remote provider became unavailable.', '2026-04-17T11:18:00.000Z',
    'provider_unavailable', NULL, NULL, NULL, '[]', '[]', NULL, 0,
    'provider_unavailable', 'connecting_provider', 'demo-host-ssh', 3
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  source_kind = excluded.source_kind,
  workspace_id = excluded.workspace_id,
  scope = excluded.scope,
  task_id = excluded.task_id,
  directory = excluded.directory,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  is_private = excluded.is_private,
  model_provider_id = excluded.model_provider_id,
  model_model_id = excluded.model_model_id,
  model_variant = excluded.model_variant,
  use_worktree = excluded.use_worktree,
  auto_approve_permissions = excluded.auto_approve_permissions,
  skip_base_branch_sync = excluded.skip_base_branch_sync,
  base_branch = excluded.base_branch,
  mode = excluded.mode,
  status = excluded.status,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at,
  last_activity_at = excluded.last_activity_at,
  session_id = excluded.session_id,
  session_server_url = excluded.session_server_url,
  error_message = excluded.error_message,
  error_timestamp = excluded.error_timestamp,
  error_code = excluded.error_code,
  worktree_original_branch = excluded.worktree_original_branch,
  worktree_working_branch = excluded.worktree_working_branch,
  worktree_path = excluded.worktree_path,
  pending_permission_requests = excluded.pending_permission_requests,
  queued_messages = excluded.queued_messages,
  active_message_id = excluded.active_message_id,
  interrupt_requested = excluded.interrupt_requested,
  connection_status = excluded.connection_status,
  startup_stage = excluded.startup_stage,
  execution_host_id = excluded.execution_host_id,
  execution_host_revision = excluded.execution_host_revision;

INSERT INTO agents (
  id, user_id, name, workspace_id, directory, prompt, code, generation_chat_id,
  model_provider_id, model_model_id, model_variant, base_branch, use_worktree,
  schedule_start_at_local, schedule_timezone, schedule_interval_value,
  schedule_interval_unit, schedule_next_run_at, enabled, mode, created_at, updated_at,
  is_private, status, last_run_at, next_run_at, last_skipped_at,
  last_error_message, last_error_timestamp, last_error_code, active_run_id
) VALUES
  (
    'demo-agent-billing', 'demo-user', 'Billing risk review', 'demo-workspace-remote',
    '/srv/workspaces/billing-api',
    'Review recent billing changes and summarize risks for the team.',
    'Review changed files, run focused tests, and report actionable risks.',
    'demo-chat-ops', 'copilot', 'gpt-5.2', '', 'main', 1, '2026-04-17T09:00',
    'America/New_York', 1, 'days', '2030-04-18T13:00:00.000Z', 0, 'paused',
    '2026-04-16T18:00:00.000Z', '2026-04-17T13:45:00.000Z', 0, 'running',
    '2026-04-17T13:40:00.000Z', '2026-04-18T13:00:00.000Z', NULL, NULL, NULL, NULL,
    'demo-agent-run-billing'
  ),
  (
    'demo-agent-docs', 'demo-user', 'Documentation gardener', 'demo-workspace-local',
    '/workspaces/demo-storefront',
    'Keep the product documentation aligned with the latest UI behavior.',
    NULL, NULL, 'claude', 'claude-sonnet', '', 'main', 0, '2026-04-17T07:30',
    'UTC', 1, 'weeks', '2030-04-24T07:30:00.000Z', 0, 'error',
    '2026-04-10T18:00:00.000Z', '2026-04-17T12:00:00.000Z', 0, 'error',
    '2026-04-17T12:00:00.000Z', NULL, '2026-04-17T11:58:00.000Z',
    'The provider rejected the configured model.', '2026-04-17T12:00:00.000Z',
    'provider_model_unavailable',
    'demo-agent-run-docs'
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  workspace_id = excluded.workspace_id,
  directory = excluded.directory,
  prompt = excluded.prompt,
  code = excluded.code,
  generation_chat_id = excluded.generation_chat_id,
  model_provider_id = excluded.model_provider_id,
  model_model_id = excluded.model_model_id,
  model_variant = excluded.model_variant,
  base_branch = excluded.base_branch,
  use_worktree = excluded.use_worktree,
  schedule_start_at_local = excluded.schedule_start_at_local,
  schedule_timezone = excluded.schedule_timezone,
  schedule_interval_value = excluded.schedule_interval_value,
  schedule_interval_unit = excluded.schedule_interval_unit,
  schedule_next_run_at = excluded.schedule_next_run_at,
  enabled = excluded.enabled,
  mode = excluded.mode,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  is_private = excluded.is_private,
  status = excluded.status,
  last_run_at = excluded.last_run_at,
  next_run_at = excluded.next_run_at,
  last_skipped_at = excluded.last_skipped_at,
  last_error_message = excluded.last_error_message,
  last_error_timestamp = excluded.last_error_timestamp,
  last_error_code = excluded.last_error_code,
  active_run_id = excluded.active_run_id;

INSERT INTO agent_runs (
  id, user_id, agent_id, chat_id, status, trigger, scheduled_for, started_at,
  completed_at, skip_reason, error_message, error_timestamp, error_code,
  session_id, session_server_url, worktree_original_branch, worktree_working_branch,
  worktree_path, pending_permission_requests, attachments, config_snapshot,
  created_at, updated_at
) VALUES
  (
    'demo-agent-run-billing', 'demo-user', 'demo-agent-billing', 'demo-chat-ops',
    'running', 'manual', '2026-04-17T13:40:00.000Z', '2026-04-17T13:40:00.000Z',
    NULL, NULL, NULL, NULL, NULL, 'demo-agent-session-billing', 'http://127.0.0.1:4302',
    'main', 'agents/demo-agent-billing', '/srv/workspaces/billing-api/.clanky-worktrees/demo-agent-billing',
    '[{"requestId":"demo-agent-permission","permission":"git_push","status":"pending"}]',
    '[]',
    '{"name":"Billing risk review","workspaceId":"demo-workspace-remote","directory":"/srv/workspaces/billing-api","prompt":"Review recent billing changes and summarize risks for the team.","model":{"providerID":"copilot","modelID":"gpt-5.2","variant":""},"useWorktree":true,"schedule":{"startAtLocal":"2026-04-17T09:00","timezone":"America/New_York","interval":{"value":1,"unit":"days"},"nextRunAt":"2026-04-18T13:00:00.000Z"}}',
    '2026-04-17T13:40:00.000Z', '2026-04-17T13:49:00.000Z'
  ),
  (
    'demo-agent-run-docs', 'demo-user', 'demo-agent-docs', NULL,
    'failed', 'schedule', '2026-04-17T12:00:00.000Z', '2026-04-17T12:00:00.000Z', NULL,
    'Provider model unavailable', 'The provider rejected the configured model.',
    '2026-04-17T12:00:00.000Z', 'provider_model_unavailable', NULL, NULL,
    'main', 'agents/demo-agent-docs', NULL, '[]', '[]',
    '{"name":"Documentation gardener","workspaceId":"demo-workspace-local","directory":"/workspaces/demo-storefront","prompt":"Keep the product documentation aligned with the latest UI behavior.","model":{"providerID":"claude","modelID":"claude-sonnet","variant":""},"useWorktree":false,"schedule":{"startAtLocal":"2026-04-17T07:30","timezone":"UTC","interval":{"value":1,"unit":"weeks"},"nextRunAt":"2026-04-24T07:30:00.000Z"}}',
    '2026-04-17T12:00:00.000Z', '2026-04-17T12:00:00.000Z'
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  agent_id = excluded.agent_id,
  chat_id = excluded.chat_id,
  status = excluded.status,
  trigger = excluded.trigger,
  scheduled_for = excluded.scheduled_for,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at,
  skip_reason = excluded.skip_reason,
  error_message = excluded.error_message,
  error_timestamp = excluded.error_timestamp,
  error_code = excluded.error_code,
  session_id = excluded.session_id,
  session_server_url = excluded.session_server_url,
  worktree_original_branch = excluded.worktree_original_branch,
  worktree_working_branch = excluded.worktree_working_branch,
  worktree_path = excluded.worktree_path,
  pending_permission_requests = excluded.pending_permission_requests,
  attachments = excluded.attachments,
  config_snapshot = excluded.config_snapshot,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

INSERT INTO terminal_sessions (
  id, user_id, name, workspace_id, task_id, directory, remote_session_name,
  connection_mode, use_tmux, workspace_execution_target_revision,
  execution_host_id, execution_host_revision, created_at, updated_at, is_private,
  status, last_connected_at, error_message, runtime_connection_mode, notice_message
) VALUES
  (
    'demo-terminal-local', 'demo-user', 'Storefront shell', 'demo-workspace-local',
    'demo-task-running', '/workspaces/demo-storefront', 'clanky-demo-storefront',
    'dtach', 1, 2, 'demo-host-local', 1, '2026-04-17T12:30:00.000Z',
    '2026-04-17T13:45:00.000Z', 0, 'connected', '2026-04-17T13:45:00.000Z',
    NULL, NULL, NULL
  ),
  (
    'demo-terminal-remote', 'demo-user', 'Billing direct shell', 'demo-workspace-remote',
    NULL, '/srv/workspaces/billing-api', 'clanky-demo-billing-direct',
    'direct', 0, 4, 'demo-host-ssh', 3, '2026-04-17T11:30:00.000Z',
    '2026-04-17T13:20:00.000Z', 0, 'ready', '2026-04-17T13:20:00.000Z',
    NULL, 'direct', 'Persistent dtach is unavailable; using a direct shell.'
  ),
  (
    'demo-terminal-mesh', 'demo-user', 'Analytics worker shell', NULL, NULL,
    '/srv/mesh/analytics-lab', 'clanky-demo-mesh-shell', 'direct', 0, NULL,
    'demo-host-mesh', 2, '2026-04-17T09:40:00.000Z', '2026-04-17T11:45:00.000Z',
    1, 'failed', '2026-04-17T11:44:00.000Z',
    'Worker disconnected while opening the shell.', NULL, NULL
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  name = excluded.name,
  workspace_id = excluded.workspace_id,
  task_id = excluded.task_id,
  directory = excluded.directory,
  remote_session_name = excluded.remote_session_name,
  connection_mode = excluded.connection_mode,
  use_tmux = excluded.use_tmux,
  workspace_execution_target_revision = excluded.workspace_execution_target_revision,
  execution_host_id = excluded.execution_host_id,
  execution_host_revision = excluded.execution_host_revision,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  is_private = excluded.is_private,
  status = excluded.status,
  last_connected_at = excluded.last_connected_at,
  error_message = excluded.error_message,
  runtime_connection_mode = excluded.runtime_connection_mode,
  notice_message = excluded.notice_message;

INSERT INTO preview_sessions (
  id, user_id, target_kind, workspace_id, execution_host_id, execution_host_revision,
  remote_host, remote_port, local_host, local_port, local_url, initial_path,
  cli_client_id, cli_hostname, created_at, updated_at, status, connected_at,
  closed_at, error_message
) VALUES
  (
    'demo-preview-storefront', 'demo-user', 'workspace', 'demo-workspace-local',
    'demo-host-local', 1, '127.0.0.1', 4173, '127.0.0.1', 54173,
    'http://127.0.0.1:54173', '/', 'demo-preview-cli', 'demo-workstation',
    '2026-04-17T12:45:00.000Z', '2026-04-17T13:45:00.000Z',
    'active', '2026-04-17T12:45:30.000Z', NULL, NULL
  ),
  (
    'demo-preview-mesh', 'demo-user', 'workspace', 'demo-workspace-mesh',
    'demo-host-mesh', 2, '127.0.0.1', 3000, '127.0.0.1', 53000,
    'http://127.0.0.1:53000', '/dashboard', 'demo-preview-mesh-cli', 'demo-laptop',
    '2026-04-17T10:10:00.000Z', '2026-04-17T11:42:00.000Z',
    'error', '2026-04-17T10:10:30.000Z', NULL,
    'Mesh worker stopped responding while forwarding the preview.'
  ),
  (
    'demo-preview-server', 'demo-user', 'server', NULL, 'demo-host-ssh', 3,
    '127.0.0.1', 8080, '127.0.0.1', 58080, 'http://127.0.0.1:58080',
    '/health', 'demo-preview-server-cli', 'demo-workstation',
    '2026-04-16T15:00:00.000Z', '2026-04-16T18:00:00.000Z',
    'closed', '2026-04-16T15:00:30.000Z', '2026-04-16T18:00:00.000Z', NULL
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  target_kind = excluded.target_kind,
  workspace_id = excluded.workspace_id,
  execution_host_id = excluded.execution_host_id,
  execution_host_revision = excluded.execution_host_revision,
  remote_host = excluded.remote_host,
  remote_port = excluded.remote_port,
  local_host = excluded.local_host,
  local_port = excluded.local_port,
  local_url = excluded.local_url,
  initial_path = excluded.initial_path,
  cli_client_id = excluded.cli_client_id,
  cli_hostname = excluded.cli_hostname,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  status = excluded.status,
  connected_at = excluded.connected_at,
  closed_at = excluded.closed_at,
  error_message = excluded.error_message;

INSERT INTO provisioning_jobs (
  id, user_id, config_json, state_json, status, workspace_id,
  created_at, updated_at, execution_host_id, execution_host_revision
) VALUES
  (
    'demo-provision-running', 'demo-user',
    '{"id":"demo-provision-running","name":"Provision Analytics Lab","executionHostBinding":{"host":{"kind":"mesh","nodeId":"demo-worker-node"},"targetKey":"demo-target-mesh","revision":2},"transport":"worker","workspaceWorkerEnrollmentId":"demo-worker-enrollment","workerEnrollmentId":"demo-worker-enrollment","workerEnrollmentRoute":"relay","repoUrl":"https://github.com/example/analytics-lab","basePath":"/srv/mesh","devcontainerSubpath":".devcontainer","provider":"codex","mode":"provision","createdAt":"2026-04-17T10:00:00.000Z"}',
    '{"status":"interrupted","currentStep":"devbox_up","targetDirectory":"/srv/mesh/analytics-lab","resolvedDirectory":"/srv/mesh/analytics-lab","error":{"code":"server_restarted","message":"Provisioning was interrupted because the Clanky server restarted.","step":"devbox_up"},"updatedAt":"2026-04-17T13:45:00.000Z","startedAt":"2026-04-17T10:05:00.000Z","completedAt":"2026-04-17T13:45:00.000Z"}',
    'interrupted', 'demo-workspace-mesh', '2026-04-17T10:00:00.000Z', '2026-04-17T13:45:00.000Z',
    'demo-host-mesh', 2
  ),
  (
    'demo-provision-failed', 'demo-user',
    '{"id":"demo-provision-failed","name":"Rebuild Billing API","executionHostBinding":{"host":{"kind":"ssh","serverId":"demo-server-build"},"targetKey":"demo-target-ssh","revision":3},"transport":"ssh","repoUrl":"https://github.com/example/billing-api","basePath":"/srv/workspaces","devcontainerSubpath":".devcontainer/api","provider":"copilot","mode":"rebuild","workspaceId":"demo-workspace-remote","targetDirectory":"/srv/workspaces/billing-api","createdAt":"2026-04-17T08:00:00.000Z"}',
    '{"status":"failed","currentStep":"devbox_rebuild","targetDirectory":"/srv/workspaces/billing-api","resolvedDirectory":"/srv/workspaces/billing-api","error":{"code":"devbox_failed","message":"The remote devbox rebuild exited with status 1.","step":"devbox_rebuild"},"updatedAt":"2026-04-17T08:20:00.000Z","startedAt":"2026-04-17T08:05:00.000Z"}',
    'failed', 'demo-workspace-remote', '2026-04-17T08:00:00.000Z', '2026-04-17T08:20:00.000Z',
    'demo-host-ssh', 3
  ),
  (
    'demo-provision-completed', 'demo-user',
    '{"id":"demo-provision-completed","name":"Provision Storefront Web","executionHostBinding":{"host":{"kind":"local","nodeId":"demo-local-node"},"targetKey":"demo-target-local","revision":1},"transport":"worker","repoUrl":"https://github.com/example/demo-storefront","basePath":"/workspaces","provider":"opencode","mode":"provision","createdAt":"2026-04-15T09:00:00.000Z"}',
    '{"status":"completed","currentStep":"workspace_ready","targetDirectory":"/workspaces/demo-storefront","resolvedDirectory":"/workspaces/demo-storefront","workspaceId":"demo-workspace-local","workspaceAction":"created","completedAt":"2026-04-15T09:30:00.000Z","updatedAt":"2026-04-15T09:30:00.000Z","startedAt":"2026-04-15T09:05:00.000Z"}',
    'completed', 'demo-workspace-local', '2026-04-15T09:00:00.000Z', '2026-04-15T09:30:00.000Z',
    'demo-host-local', 1
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  config_json = excluded.config_json,
  state_json = excluded.state_json,
  status = excluded.status,
  workspace_id = excluded.workspace_id,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  execution_host_id = excluded.execution_host_id,
  execution_host_revision = excluded.execution_host_revision;

INSERT INTO provisioning_job_logs (id, job_id, source, text, timestamp, step) VALUES
  ('demo-provision-log-1', 'demo-provision-running', 'system', 'Worker accepted provisioning job.', '2026-04-17T10:05:00.000Z', 'prepare_directory'),
  ('demo-provision-log-2', 'demo-provision-running', 'stdout', 'Starting devbox up for analytics-lab.', '2026-04-17T13:44:00.000Z', 'devbox_up'),
  ('demo-provision-log-3', 'demo-provision-failed', 'stderr', 'devbox: command exited with status 1', '2026-04-17T08:20:00.000Z', 'devbox_rebuild'),
  ('demo-provision-log-4', 'demo-provision-completed', 'system', 'Workspace is ready.', '2026-04-15T09:30:00.000Z', 'workspace_ready')
ON CONFLICT(id) DO UPDATE SET
  job_id = excluded.job_id,
  source = excluded.source,
  text = excluded.text,
  timestamp = excluded.timestamp,
  step = excluded.step;

INSERT INTO review_comments (
  id, user_id, task_id, review_cycle, comment_text, created_at, status, addressed_at
) VALUES
  (
    'demo-review-comment-1', 'demo-user', 'demo-task-completed', 1,
    'Please add a regression case for an empty date range.', '2026-04-16T14:00:00.000Z',
    'addressed', '2026-04-16T15:10:00.000Z'
  ),
  (
    'demo-review-comment-2', 'demo-user', 'demo-task-completed', 1,
    'The filter labels should remain readable at the mobile breakpoint.', '2026-04-16T14:05:00.000Z',
    'pending', NULL
  ),
  (
    'demo-review-comment-3', 'demo-user', 'demo-task-running', 2,
    'The retry backoff needs a maximum delay before the next attempt.', '2026-04-17T13:30:00.000Z',
    'pending', NULL
  )
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  task_id = excluded.task_id,
  review_cycle = excluded.review_cycle,
  comment_text = excluded.comment_text,
  created_at = excluded.created_at,
  status = excluded.status,
  addressed_at = excluded.addressed_at;

-- Normalized task transcript entries cover messages, tools and logs.
INSERT INTO task_transcript_entries (
  task_id, user_id, entry_id, kind, timestamp, sequence, payload,
  tool_name, tool_status, tool_input, tool_output, tool_extras, message_role,
  created_at, updated_at
) VALUES
  (
    'demo-task-planning', 'demo-user', 'message:demo-task-planning-user', 'message',
    '2026-04-17T12:31:00.000Z', 0,
    '{"id":"demo-task-planning-user","role":"user","content":"I want filters that are useful on both desktop and mobile.","timestamp":"2026-04-17T12:31:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'user', '2026-04-17T12:31:00.000Z', '2026-04-17T12:31:00.000Z'
  ),
  (
    'demo-task-planning', 'demo-user', 'message:demo-task-planning-assistant', 'message',
    '2026-04-17T12:32:00.000Z', 1,
    '{"id":"demo-task-planning-assistant","role":"assistant","content":"I drafted a responsive filter plan and need one product decision before implementation.","timestamp":"2026-04-17T12:32:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T12:32:00.000Z', '2026-04-17T12:32:00.000Z'
  ),
  (
    'demo-task-planning', 'demo-user', 'tool:demo-task-planning-tool', 'tool',
    '2026-04-17T12:33:00.000Z', 2, '{}', 'Glob', 'completed',
    '{"pattern":"src/components/**/*filter*"}', '["src/components/dashboard/filters.tsx"]', '[]', NULL,
    '2026-04-17T12:33:00.000Z', '2026-04-17T12:33:00.000Z'
  ),
  (
    'demo-task-planning', 'demo-user', 'log:demo-task-planning-log', 'log',
    '2026-04-17T12:34:00.000Z', 3,
    '{"id":"demo-task-planning-log","level":"info","message":"Plan is ready for review.","timestamp":"2026-04-17T12:34:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, NULL, '2026-04-17T12:34:00.000Z', '2026-04-17T12:34:00.000Z'
  ),
  (
    'demo-task-running', 'demo-user', 'message:demo-task-running-user', 'message',
    '2026-04-17T13:41:00.000Z', 0,
    '{"id":"demo-task-running-user","role":"user","content":"Please keep the retry behavior backwards compatible.","timestamp":"2026-04-17T13:41:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'user', '2026-04-17T13:41:00.000Z', '2026-04-17T13:41:00.000Z'
  ),
  (
    'demo-task-running', 'demo-user', 'message:demo-task-running-assistant', 'message',
    '2026-04-17T13:42:00.000Z', 1,
    '{"id":"demo-task-running-assistant","role":"assistant","content":"I found the retry policy and am adding an idempotency test next.","timestamp":"2026-04-17T13:42:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T13:42:00.000Z', '2026-04-17T13:42:00.000Z'
  ),
  (
    'demo-task-running', 'demo-user', 'tool:demo-task-running-tool', 'tool',
    '2026-04-17T13:43:00.000Z', 2, '{}', 'Edit', 'running',
    '{"filePath":"src/webhooks/retry.ts"}', NULL, '[]', NULL,
    '2026-04-17T13:43:00.000Z', '2026-04-17T13:43:00.000Z'
  ),
  (
    'demo-task-failed', 'demo-user', 'message:demo-task-failed-assistant', 'message',
    '2026-04-17T11:41:00.000Z', 0,
    '{"id":"demo-task-failed-assistant","role":"assistant","content":"The worker disconnected before I could collect the preview logs.","timestamp":"2026-04-17T11:41:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T11:41:00.000Z', '2026-04-17T11:41:00.000Z'
  )
ON CONFLICT(task_id, entry_id) DO UPDATE SET
  user_id = excluded.user_id,
  kind = excluded.kind,
  timestamp = excluded.timestamp,
  sequence = excluded.sequence,
  payload = excluded.payload,
  tool_name = excluded.tool_name,
  tool_status = excluded.tool_status,
  tool_input = excluded.tool_input,
  tool_output = excluded.tool_output,
  tool_extras = excluded.tool_extras,
  message_role = excluded.message_role,
  updated_at = excluded.updated_at;

INSERT INTO task_transcript_meta (task_id, user_id, revision, entry_count, updated_at) VALUES
  ('demo-task-planning', 'demo-user', '4:2026-04-17T12:34:00.000Z:2026-04-17T12:34:00.000Z', 4, '2026-04-17T12:34:00.000Z'),
  ('demo-task-running', 'demo-user', '3:2026-04-17T13:43:00.000Z:2026-04-17T13:43:00.000Z', 3, '2026-04-17T13:43:00.000Z'),
  ('demo-task-failed', 'demo-user', '1:2026-04-17T11:41:00.000Z:2026-04-17T11:41:00.000Z', 1, '2026-04-17T11:41:00.000Z')
ON CONFLICT(task_id) DO UPDATE SET
  user_id = excluded.user_id,
  revision = excluded.revision,
  entry_count = excluded.entry_count,
  updated_at = excluded.updated_at;

INSERT INTO chat_transcript_entries (
  chat_id, user_id, entry_id, kind, timestamp, sequence, payload,
  tool_name, tool_status, tool_input, tool_output, tool_extras, message_role,
  created_at, updated_at
) VALUES
  (
    'demo-chat-storefront', 'demo-user', 'message:demo-chat-storefront-user', 'message',
    '2026-04-17T13:46:00.000Z', 0,
    '{"id":"demo-chat-storefront-user","role":"user","content":"Can you inspect the failing test and suggest a fix?","timestamp":"2026-04-17T13:46:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'user', '2026-04-17T13:46:00.000Z', '2026-04-17T13:46:00.000Z'
  ),
  (
    'demo-chat-storefront', 'demo-user', 'message:demo-chat-storefront-assistant', 'message',
    '2026-04-17T13:47:00.000Z', 1,
    '{"id":"demo-chat-storefront-assistant","role":"assistant","content":"The failure is isolated to the mocked date boundary. I am checking the surrounding tests now.","timestamp":"2026-04-17T13:47:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T13:47:00.000Z', '2026-04-17T13:47:00.000Z'
  ),
  (
    'demo-chat-storefront', 'demo-user', 'tool:demo-chat-storefront-tool', 'tool',
    '2026-04-17T13:48:00.000Z', 2, '{}', 'Read', 'completed',
    '{"filePath":"tests/dashboard/filters.test.ts"}',
    '"The date helper uses the local timezone."', '[]', NULL,
    '2026-04-17T13:48:00.000Z', '2026-04-17T13:48:00.000Z'
  ),
  (
    'demo-chat-host', 'demo-user', 'message:demo-chat-host-user', 'message',
    '2026-04-17T09:31:00.000Z', 0,
    '{"id":"demo-chat-host-user","role":"user","content":"Show me the worker capabilities.","timestamp":"2026-04-17T09:31:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'user', '2026-04-17T09:31:00.000Z', '2026-04-17T09:31:00.000Z'
  ),
  (
    'demo-chat-host', 'demo-user', 'message:demo-chat-host-assistant', 'message',
    '2026-04-17T09:32:00.000Z', 1,
    '{"id":"demo-chat-host-assistant","role":"assistant","content":"The Mesh worker exposes shell, Git and Docker capabilities.","timestamp":"2026-04-17T09:32:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T09:32:00.000Z', '2026-04-17T09:32:00.000Z'
  )
ON CONFLICT(chat_id, entry_id) DO UPDATE SET
  user_id = excluded.user_id,
  kind = excluded.kind,
  timestamp = excluded.timestamp,
  sequence = excluded.sequence,
  payload = excluded.payload,
  tool_name = excluded.tool_name,
  tool_status = excluded.tool_status,
  tool_input = excluded.tool_input,
  tool_output = excluded.tool_output,
  tool_extras = excluded.tool_extras,
  message_role = excluded.message_role,
  updated_at = excluded.updated_at;

INSERT INTO chat_transcript_meta (chat_id, user_id, revision, entry_count, updated_at) VALUES
  ('demo-chat-storefront', 'demo-user', '3:2026-04-17T13:48:00.000Z:2026-04-17T13:48:00.000Z', 3, '2026-04-17T13:48:00.000Z'),
  ('demo-chat-host', 'demo-user', '2:2026-04-17T09:32:00.000Z:2026-04-17T09:32:00.000Z', 2, '2026-04-17T09:32:00.000Z')
ON CONFLICT(chat_id) DO UPDATE SET
  user_id = excluded.user_id,
  revision = excluded.revision,
  entry_count = excluded.entry_count,
  updated_at = excluded.updated_at;

INSERT INTO agent_run_transcript_entries (
  agent_run_id, user_id, entry_id, kind, timestamp, sequence, payload,
  tool_name, tool_status, tool_input, tool_output, tool_extras, message_role,
  created_at, updated_at
) VALUES
  (
    'demo-agent-run-billing', 'demo-user', 'message:demo-agent-run-billing-user', 'message',
    '2026-04-17T13:41:00.000Z', 0,
    '{"id":"demo-agent-run-billing-user","role":"user","content":"Review the webhook retry changes.","timestamp":"2026-04-17T13:41:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'user', '2026-04-17T13:41:00.000Z', '2026-04-17T13:41:00.000Z'
  ),
  (
    'demo-agent-run-billing', 'demo-user', 'message:demo-agent-run-billing-assistant', 'message',
    '2026-04-17T13:42:00.000Z', 1,
    '{"id":"demo-agent-run-billing-assistant","role":"assistant","content":"I found one retry path that can duplicate a charge event; I am validating the idempotency key flow.","timestamp":"2026-04-17T13:42:00.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T13:42:00.000Z', '2026-04-17T13:42:00.000Z'
  ),
  (
    'demo-agent-run-billing', 'demo-user', 'tool:demo-agent-run-billing-tool', 'tool',
    '2026-04-17T13:43:00.000Z', 2, '{}', 'Grep', 'completed',
    '{"pattern":"idempotency","path":"src"}', '"src/webhooks/retry.ts:42"', '[]', NULL,
    '2026-04-17T13:43:00.000Z', '2026-04-17T13:43:00.000Z'
  ),
  (
    'demo-agent-run-docs', 'demo-user', 'message:demo-agent-run-docs-assistant', 'message',
    '2026-04-17T12:00:30.000Z', 0,
    '{"id":"demo-agent-run-docs-assistant","role":"assistant","content":"I could not start because the configured provider model is unavailable.","timestamp":"2026-04-17T12:00:30.000Z"}',
    NULL, NULL, NULL, NULL, NULL, 'assistant', '2026-04-17T12:00:30.000Z', '2026-04-17T12:00:30.000Z'
  )
ON CONFLICT(agent_run_id, entry_id) DO UPDATE SET
  user_id = excluded.user_id,
  kind = excluded.kind,
  timestamp = excluded.timestamp,
  sequence = excluded.sequence,
  payload = excluded.payload,
  tool_name = excluded.tool_name,
  tool_status = excluded.tool_status,
  tool_input = excluded.tool_input,
  tool_output = excluded.tool_output,
  tool_extras = excluded.tool_extras,
  message_role = excluded.message_role,
  updated_at = excluded.updated_at;

INSERT INTO agent_run_transcript_meta (agent_run_id, user_id, revision, entry_count, updated_at) VALUES
  ('demo-agent-run-billing', 'demo-user', '3:2026-04-17T13:43:00.000Z:2026-04-17T13:43:00.000Z', 3, '2026-04-17T13:43:00.000Z'),
  ('demo-agent-run-docs', 'demo-user', '1:2026-04-17T12:00:30.000Z:2026-04-17T12:00:30.000Z', 1, '2026-04-17T12:00:30.000Z')
ON CONFLICT(agent_run_id) DO UPDATE SET
  user_id = excluded.user_id,
  revision = excluded.revision,
  entry_count = excluded.entry_count,
  updated_at = excluded.updated_at;

COMMIT;
