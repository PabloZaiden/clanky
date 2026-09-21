import type { Database } from "bun:sqlite";

/**
 * Creates the schema that is already present in the production installation.
 *
 * The statements intentionally use IF NOT EXISTS so this can run before the
 * migration runner against both a new database and the consolidated
 * production baseline. Every table added here must also be classified in
 * `schema-inventory.ts`.
 */
export function createBaseSchema(
  database: Database,
): void {
  const createSchema = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS webapp_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        auth_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webapp_passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS webapp_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS webapp_device_auth_requests (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (approved_by_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_refresh_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS execution_hosts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'mesh', 'ssh')),
        source_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        platform_os TEXT,
        platform_architecture TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (user_id, kind, source_id)
      );
      CREATE TABLE IF NOT EXISTS ssh_servers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        repositories_base_path TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        port INTEGER NOT NULL DEFAULT 22
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        workspace_type TEXT NOT NULL DEFAULT 'git',
        execution_target_revision INTEGER NOT NULL DEFAULT 1,
        execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE RESTRICT,
        execution_host_revision INTEGER NOT NULL,
        server_settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        allow_clanky_context INTEGER NOT NULL DEFAULT 0,
        source_directory TEXT,
        repo_url TEXT,
        base_path TEXT,
        devcontainer_subpath TEXT,
        provisioning_host_id TEXT REFERENCES execution_hosts(id) ON DELETE SET NULL,
        provisioning_host_revision INTEGER,
        allow_worktrees INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace', 'execution_host')),
        workspace_id TEXT,
        scope TEXT NOT NULL DEFAULT 'workspace',
        task_id TEXT,
        directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model_provider_id TEXT,
        model_model_id TEXT,
        model_variant TEXT,
        use_worktree INTEGER NOT NULL DEFAULT 1,
        auto_approve_permissions INTEGER NOT NULL DEFAULT 1,
        skip_base_branch_sync INTEGER NOT NULL DEFAULT 0,
        base_branch TEXT,
        mode TEXT NOT NULL DEFAULT 'chat',
        status TEXT NOT NULL DEFAULT 'idle',
        started_at TEXT,
        completed_at TEXT,
        last_activity_at TEXT,
        session_id TEXT,
        session_server_url TEXT,
        error_message TEXT,
        error_timestamp TEXT,
        error_code TEXT,
        worktree_original_branch TEXT,
        worktree_working_branch TEXT,
        worktree_path TEXT,
        pending_permission_requests TEXT,
        queued_messages TEXT,
        active_message_id TEXT,
        interrupt_requested INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'disconnected',
        is_private INTEGER NOT NULL DEFAULT 0,
        startup_stage TEXT,
        execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
        execution_host_revision INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CHECK (
          (source_kind = 'workspace' AND workspace_id IS NOT NULL)
          OR (source_kind = 'execution_host' AND workspace_id IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model_provider_id TEXT,
        model_model_id TEXT,
        model_variant TEXT,
        max_iterations INTEGER,
        max_consecutive_errors INTEGER,
        activity_timeout_seconds INTEGER,
        stop_pattern TEXT NOT NULL,
        git_branch_prefix TEXT NOT NULL,
        git_commit_scope TEXT NOT NULL DEFAULT 'clanky',
        base_branch TEXT,
        clear_planning_folder INTEGER DEFAULT 0,
        plan_mode INTEGER DEFAULT 0,
        auto_accept_plan INTEGER NOT NULL DEFAULT 0,
        mode TEXT DEFAULT 'task',
        workspace_id TEXT REFERENCES workspaces(id),
        cheap_model TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        current_iteration INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        last_activity_at TEXT,
        session_id TEXT,
        session_server_url TEXT,
        error_message TEXT,
        error_iteration INTEGER,
        error_timestamp TEXT,
        git_original_branch TEXT,
        git_working_branch TEXT,
        git_worktree_path TEXT,
        git_commits TEXT,
        recent_iterations TEXT,
        consecutive_errors TEXT,
        pending_prompt TEXT,
        pending_prompt_mode TEXT,
        pending_model_provider_id TEXT,
        pending_model_model_id TEXT,
        pending_model_variant TEXT,
        plan_mode_active INTEGER DEFAULT 0,
        plan_session_id TEXT,
        plan_server_url TEXT,
        plan_feedback_rounds INTEGER DEFAULT 0,
        plan_content TEXT,
        planning_folder_cleared INTEGER DEFAULT 0,
        plan_is_ready INTEGER DEFAULT 0,
        review_mode TEXT,
        pull_request_monitoring TEXT,
        automatic_pr_flow TEXT,
        fully_autonomous INTEGER NOT NULL DEFAULT 0,
        fully_autonomous_pending INTEGER NOT NULL DEFAULT 0,
        use_worktree INTEGER NOT NULL DEFAULT 1,
        plan_mode_auto_reply INTEGER NOT NULL DEFAULT 1,
        pending_plan_question TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        issue_number INTEGER
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model_provider_id TEXT NOT NULL,
        model_model_id TEXT NOT NULL,
        model_variant TEXT,
        base_branch TEXT,
        use_worktree INTEGER NOT NULL DEFAULT 1,
        schedule_start_at_local TEXT NOT NULL,
        schedule_timezone TEXT NOT NULL,
        schedule_interval_value INTEGER NOT NULL,
        schedule_interval_unit TEXT NOT NULL,
        schedule_next_run_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT,
        last_skipped_at TEXT,
        last_error_message TEXT,
        last_error_timestamp TEXT,
        last_error_code TEXT,
        active_run_id TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        code TEXT,
        generation_chat_id TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        chat_id TEXT,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        skip_reason TEXT,
        error_message TEXT,
        error_timestamp TEXT,
        error_code TEXT,
        session_id TEXT,
        session_server_url TEXT,
        worktree_original_branch TEXT,
        worktree_working_branch TEXT,
        worktree_path TEXT,
        pending_permission_requests TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]',
        config_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_transcript_entries (
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tool_name TEXT,
        tool_status TEXT,
        tool_input TEXT,
        tool_output TEXT,
        tool_extras TEXT,
        message_role TEXT,
        PRIMARY KEY (chat_id, entry_id),
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS chat_transcript_meta (
        chat_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_run_transcript_entries (
        agent_run_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        tool_name TEXT,
        tool_status TEXT,
        tool_input TEXT,
        tool_output TEXT,
        tool_extras TEXT,
        message_role TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_run_id, entry_id),
        FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_run_transcript_meta (
        agent_run_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_transcript_entries (
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'log')),
        timestamp TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        tool_name TEXT,
        tool_status TEXT,
        tool_input TEXT,
        tool_output TEXT,
        tool_extras TEXT,
        message_role TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, entry_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS task_transcript_meta (
        task_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS clanky_context_api_keys (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        context_type TEXT NOT NULL,
        context_id TEXT NOT NULL,
        api_key_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (user_id, workspace_id, context_type, context_id, generation)
      );
      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT,
        task_id TEXT,
        directory TEXT NOT NULL,
        remote_session_name TEXT NOT NULL,
        connection_mode TEXT NOT NULL DEFAULT 'dtach',
        use_tmux INTEGER NOT NULL DEFAULT 0,
        workspace_execution_target_revision INTEGER,
        execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
        execution_host_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready',
        last_connected_at TEXT,
        error_message TEXT,
        runtime_connection_mode TEXT,
        notice_message TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS preview_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        target_kind TEXT NOT NULL DEFAULT 'workspace'
          CHECK (target_kind IN ('workspace', 'server')),
        workspace_id TEXT,
        execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
        execution_host_revision INTEGER NOT NULL,
        remote_host TEXT NOT NULL,
        remote_port INTEGER NOT NULL,
        local_host TEXT NOT NULL,
        local_port INTEGER NOT NULL,
        local_url TEXT NOT NULL,
        initial_path TEXT NOT NULL,
        cli_client_id TEXT,
        cli_hostname TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        connected_at TEXT,
        closed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CHECK (
          (target_kind = 'workspace' AND workspace_id IS NOT NULL)
          OR (target_kind = 'server' AND workspace_id IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS provisioning_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        execution_host_id TEXT NOT NULL REFERENCES execution_hosts(id) ON DELETE CASCADE,
        execution_host_revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provisioning_job_logs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        source TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        step TEXT,
        FOREIGN KEY (job_id) REFERENCES provisioning_jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        review_cycle INTEGER NOT NULL,
        comment_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        addressed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sessions (
        backend_name TEXT NOT NULL,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        server_url TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (backend_name, task_id)
      );
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_execution_targets (
        workspace_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        host TEXT,
        port INTEGER,
        username TEXT,
        password_ciphertext TEXT,
        target_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workspace_worker_enrollments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'connected', 'claimed', 'attached',
                     'cancelled', 'expired', 'failed')
        ),
        worker_node_id TEXT,
        workspace_id TEXT UNIQUE,
        claimed_by TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        connected_at TEXT,
        attached_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mesh_controller_grants (
        controller_node_id TEXT NOT NULL,
        controller_instance_name TEXT,
        controller_public_key TEXT NOT NULL,
        controller_fingerprint TEXT NOT NULL,
        controller_encryption_public_key TEXT NOT NULL,
        grant_status TEXT NOT NULL DEFAULT 'active'
          CHECK (grant_status IN ('active', 'revoked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        controller_endpoint TEXT,
        route_kind TEXT NOT NULL DEFAULT 'direct',
        relay_url TEXT,
        relay_fingerprint TEXT,
        PRIMARY KEY (controller_node_id)
      );
      CREATE TABLE IF NOT EXISTS mesh_controller_relay_pairing (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        relay_url TEXT NOT NULL,
        relay_public_key TEXT NOT NULL,
        relay_fingerprint TEXT NOT NULL,
        controller_node_id TEXT NOT NULL,
        controller_fingerprint TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mesh_enrollment_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        controller_node_id TEXT NOT NULL,
        controller_fingerprint TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'global',
        workspace_worker_enrollment_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mesh_node_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        node_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        encryption_public_key TEXT NOT NULL,
        instance_name TEXT,
        mesh_endpoint TEXT,
        execution_config_json TEXT
      );
      CREATE TABLE IF NOT EXISTS mesh_worker_kill_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mesh_worker_registrations (
        worker_node_id TEXT NOT NULL,
        local_user_id TEXT NOT NULL,
        worker_instance_name TEXT,
        worker_endpoint TEXT NOT NULL,
        worker_transport TEXT NOT NULL DEFAULT 'https',
        worker_public_key TEXT NOT NULL,
        worker_fingerprint TEXT NOT NULL,
        worker_encryption_public_key TEXT NOT NULL,
        worker_directory TEXT,
        worker_capabilities_json TEXT,
        worker_accept_remote_execution INTEGER NOT NULL DEFAULT 1,
        worker_config_revision INTEGER NOT NULL DEFAULT 1,
        registration_scope TEXT NOT NULL DEFAULT 'global'
          CHECK (registration_scope IN ('global', 'workspace')),
        workspace_worker_enrollment_id TEXT,
        workspace_id TEXT,
        grant_status TEXT NOT NULL DEFAULT 'active'
          CHECK (grant_status IN ('active', 'revoked')),
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        worker_tls_certificate TEXT,
        worker_tls_fingerprint TEXT,
        route_kind TEXT NOT NULL DEFAULT 'direct',
        relay_url TEXT,
        relay_fingerprint TEXT,
        worker_platform_os TEXT,
        worker_platform_architecture TEXT,
        PRIMARY KEY (local_user_id, worker_node_id)
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webapp_users_username ON webapp_users(username);
      CREATE INDEX IF NOT EXISTS idx_webapp_passkeys_user ON webapp_passkeys(user_id);
      CREATE INDEX IF NOT EXISTS idx_webapp_api_keys_user ON webapp_api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_webapp_refresh_user ON webapp_refresh_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_execution_hosts_user_kind
        ON execution_hosts(user_id, kind, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_execution_hosts_user_revoked
        ON execution_hosts(user_id, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_execution_hosts_user_target
        ON execution_hosts(user_id, target_key);
      CREATE INDEX IF NOT EXISTS idx_workspaces_execution_host
        ON workspaces(execution_host_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_user_updated
        ON workspaces(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at
        ON tasks(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_workspace_id
        ON tasks(user_id, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id
        ON tasks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_chats_created_at
        ON chats(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chats_workspace_created_at
        ON chats(user_id, workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chats_directory_workspace_status
        ON chats(user_id, directory, workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_chats_execution_host
        ON chats(execution_host_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_task_id_unique
        ON chats(user_id, task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agents_workspace_created_at
        ON agents(user_id, workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_enabled_next_run
        ON agents(user_id, enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_created_at
        ON agent_runs(user_id, agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status
        ON agent_runs(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_chat_transcript_entries_page
        ON chat_transcript_entries(user_id, chat_id, timestamp DESC, sequence DESC, kind DESC, entry_id DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_transcript_meta_user
        ON chat_transcript_meta(user_id, chat_id);
      CREATE INDEX IF NOT EXISTS idx_agent_run_transcript_entries_page
        ON agent_run_transcript_entries(user_id, agent_run_id, timestamp DESC, sequence DESC, kind DESC, entry_id DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_run_transcript_meta_user
        ON agent_run_transcript_meta(user_id, agent_run_id);
      CREATE INDEX IF NOT EXISTS idx_task_transcript_entries_page
        ON task_transcript_entries(user_id, task_id, timestamp DESC, sequence DESC, kind DESC, entry_id DESC);
      CREATE INDEX IF NOT EXISTS idx_task_transcript_meta_user
        ON task_transcript_meta(user_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_clanky_context_api_keys_context
        ON clanky_context_api_keys(user_id, workspace_id, context_type, context_id);
      CREATE INDEX IF NOT EXISTS idx_clanky_context_api_keys_workspace
        ON clanky_context_api_keys(user_id, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_created_at
        ON terminal_sessions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace_id
        ON terminal_sessions(user_id, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_terminal_sessions_execution_host
        ON terminal_sessions(execution_host_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_sessions_task_id_unique
        ON terminal_sessions(user_id, task_id) WHERE task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_preview_sessions_status_updated
        ON preview_sessions(user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_preview_sessions_workspace_created
        ON preview_sessions(user_id, workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_execution_host
        ON provisioning_jobs(execution_host_id);
      CREATE INDEX IF NOT EXISTS idx_provisioning_job_logs_job_timestamp
        ON provisioning_job_logs(job_id, timestamp ASC);
      CREATE INDEX IF NOT EXISTS idx_review_comments_task_id
        ON review_comments(task_id);
      CREATE INDEX IF NOT EXISTS idx_review_comments_task_cycle
        ON review_comments(task_id, review_cycle);
      CREATE INDEX IF NOT EXISTS idx_review_comments_user_task_id
        ON review_comments(user_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_ssh_servers_name
        ON ssh_servers(user_id, name COLLATE NOCASE, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_workspace_execution_targets_user
        ON workspace_execution_targets(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_worker_enrollments_owner
        ON workspace_worker_enrollments(user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_worker_enrollments_worker
        ON workspace_worker_enrollments(user_id, worker_node_id);
      CREATE INDEX IF NOT EXISTS idx_mesh_enrollment_tokens_owner
        ON mesh_enrollment_tokens(user_id, expires_at, consumed_at);
      CREATE INDEX IF NOT EXISTS idx_mesh_worker_kill_nonces_expires_at
        ON mesh_worker_kill_nonces(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mesh_worker_registrations_scope
        ON mesh_worker_registrations(local_user_id, registration_scope, grant_status);
      CREATE INDEX IF NOT EXISTS idx_mesh_worker_registrations_user
        ON mesh_worker_registrations(local_user_id);
    `);
  });

  createSchema();
}
