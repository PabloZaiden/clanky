import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { getSchemaVersion, migrations, runMigrations } from "../../src/persistence/migrations";
import { migrateCanonicalExecutionHosts } from "../../src/persistence/migrations/canonical-execution-hosts";

const PRIVATE_FLAG_TABLE_NAMES = [
  "workspaces",
  "tasks",
  "chats",
  "agents",
  "ssh_servers",
  "terminal_sessions",
] as const;

type PrivateFlagTableName = typeof PRIVATE_FLAG_TABLE_NAMES[number];

const HISTORICAL_PRIVATE_FLAG_TABLE_NAMES = [
  "workspaces",
  "tasks",
  "chats",
  "agents",
  "ssh_servers",
  "ssh_server_sessions",
] as const;

type HistoricalPrivateFlagTableName = typeof HISTORICAL_PRIVATE_FLAG_TABLE_NAMES[number];

async function withTempDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "clanky-db-schema-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  try {
    await run(dataDir);
  } finally {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  }
}

function tableNames(): string[] {
  return (
    getDatabase()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function assertPrivateFlagTableName(tableName: string): asserts tableName is PrivateFlagTableName {
  if (!(PRIVATE_FLAG_TABLE_NAMES as readonly string[]).includes(tableName)) {
    throw new Error(`Unexpected schema table name: ${tableName}`);
  }
}

function columnNames(tableName: PrivateFlagTableName): string[] {
  assertPrivateFlagTableName(tableName);
  return (
    getDatabase()
      .query(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function privateFlagColumnInfo(db: Database, tableName: HistoricalPrivateFlagTableName): Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}> {
  if (!(HISTORICAL_PRIVATE_FLAG_TABLE_NAMES as readonly string[]).includes(tableName)) {
    throw new Error(`Unexpected historical schema table name: ${tableName}`);
  }
  return db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function workspaceColumnInfo(db: Database): Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}> {
  return db.query("PRAGMA table_info(workspaces)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function createCanonicalMigrationFixture(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE execution_hosts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ssh_servers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      username TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      repositories_base_path TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      directory TEXT NOT NULL,
      workspace_type TEXT NOT NULL DEFAULT 'git',
      execution_node_id TEXT,
      execution_target_revision INTEGER NOT NULL DEFAULT 1,
      server_fingerprint TEXT NOT NULL,
      execution_host_id TEXT,
      execution_host_revision INTEGER,
      server_settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      allow_clanky_context INTEGER NOT NULL DEFAULT 0,
      source_directory TEXT,
      ssh_server_id TEXT,
      repo_url TEXT,
      base_path TEXT,
      devcontainer_subpath TEXT,
      provider TEXT
    );
    CREATE TABLE terminal_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      directory TEXT NOT NULL,
      remote_session_name TEXT NOT NULL,
      connection_mode TEXT NOT NULL DEFAULT 'dtach',
      use_tmux INTEGER NOT NULL DEFAULT 0,
      target_revision INTEGER NOT NULL DEFAULT 1,
      execution_host_id TEXT,
      execution_host_revision INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      last_connected_at TEXT,
      error_message TEXT,
      runtime_connection_mode TEXT,
      notice_message TEXT,
      target_transport TEXT NOT NULL DEFAULT 'stdio',
      target_key TEXT NOT NULL DEFAULT '',
      target_hostname TEXT,
      target_port INTEGER,
      target_username TEXT,
      target_execution_node_id TEXT
    );
    CREATE TABLE ssh_server_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ssh_server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      remote_session_name TEXT NOT NULL,
      connection_mode TEXT NOT NULL DEFAULT 'dtach',
      use_tmux INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      last_connected_at TEXT,
      error_message TEXT,
      runtime_connection_mode TEXT,
      notice_message TEXT
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      workspace_id TEXT,
      ssh_server_id TEXT,
      ssh_server_session_id TEXT,
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
      execution_host_id TEXT,
      execution_host_revision INTEGER
    );
    CREATE TABLE chat_transcript_entries (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, entry_id),
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE TABLE chat_transcript_meta (
      chat_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    CREATE TABLE vnc_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ssh_server_id TEXT,
      remote_host TEXT NOT NULL DEFAULT '127.0.0.1',
      remote_port INTEGER NOT NULL,
      local_port INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      connected_at TEXT,
      error_message TEXT,
      execution_host_id TEXT,
      execution_host_revision INTEGER
    );
    CREATE TABLE provisioning_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      execution_host_id TEXT,
      execution_host_revision INTEGER
    );
  `);
}

describe("database schema", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("creates a clean post-migration baseline schema", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();

      expect(tableNames()).toContain("preview_sessions");
      for (const tableName of PRIVATE_FLAG_TABLE_NAMES) {
        expect(columnNames(tableName)).toContain("is_private");
      }
      expect(columnNames("workspaces")).toContain("archived");
      expect(columnNames("workspaces")).toContain("allow_clanky_context");
      expect(columnNames("workspaces")).not.toContain("execution_node_id");
      expect(columnNames("workspaces")).toContain("execution_target_revision");
      expect(columnNames("workspaces")).toContain("execution_host_id");
      expect(columnNames("workspaces")).toContain("execution_host_revision");
      expect(columnNames("workspaces")).toContain("workspace_type");
      expect(columnNames("chats")).toContain("queued_messages");
      expect(columnNames("tasks")).toContain("issue_number");
      expect(tableNames()).toContain("clanky_context_api_keys");
      expect(tableNames()).toContain("terminal_sessions");
      expect(tableNames()).toContain("execution_hosts");
      const terminalCols = (getDatabase().query("PRAGMA table_info(terminal_sessions)").all() as Array<{ name: string }>).map((r) => r.name);
      expect(terminalCols).not.toContain("target_transport");
      expect(terminalCols).not.toContain("target_key");
      expect(terminalCols).not.toContain("target_revision");
      expect(terminalCols).toContain("execution_host_id");
      expect(terminalCols).toContain("execution_host_revision");
      for (const tableName of [
        "workspaces",
        "chats",
        "provisioning_jobs",
        "vnc_sessions",
      ]) {
        const columns = (
          getDatabase().query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(columns).toContain("execution_host_id");
        expect(columns).toContain("execution_host_revision");
      }
      const sshServerColumns = (
        getDatabase().query("PRAGMA table_info(ssh_servers)").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(sshServerColumns).toContain("port");
      expect(tableNames()).not.toContain("ssh_sessions");

      const users = getDatabase()
        .query("SELECT COUNT(*) AS count FROM webapp_users")
        .get() as { count: number };
      expect(users.count).toBe(0);
      expect(getSchemaVersion(getDatabase())).toBe(migrations.at(-1)?.version ?? 0);
    });
  });

  // This persistence-boundary scenario protects the only upgrade where several
  // user-visible resource types move to one canonical execution-host identity.
  test("migration v46 preserves valid SSH resources and removes synthetic sessions", () => {
      const db = new Database(":memory:");
      const now = "2026-01-01T00:00:00.000Z";
      try {
        createCanonicalMigrationFixture(db);
        db.run(`
          INSERT INTO execution_hosts (
            id, user_id, kind, source_id, target_key, revision, created_at, updated_at
          ) VALUES ('host-ssh', 'user-1', 'ssh', 'ssh-1', 'sha256:target', 3, ?, ?)
        `, [now, now]);
        db.run(`
          INSERT INTO ssh_servers (
            id, user_id, name, address, username, port, created_at, updated_at,
            repositories_base_path
          ) VALUES ('ssh-1', 'user-1', 'Build host', 'build.example', 'builder', 22, ?, ?, '/srv/repos')
        `, [now, now]);
        db.run(`
          INSERT INTO workspaces (
            id, user_id, name, directory, workspace_type,
            execution_target_revision, server_fingerprint, execution_host_id,
            execution_host_revision, server_settings, created_at, updated_at,
            ssh_server_id, provider
          ) VALUES (
            'workspace-1', 'user-1', 'Project', '/srv/repos/project', 'git',
            7, 'legacy-fingerprint', 'host-ssh', 3,
            '{"agent":{"transport":"ssh","hostname":"build.example","provider":"copilot"}}',
            ?, ?, 'ssh-1', 'claude'
          )
        `, [now, now]);
        db.run(`
          INSERT INTO terminal_sessions (
            id, user_id, name, workspace_id, directory, remote_session_name,
            target_revision, created_at, updated_at
          ) VALUES (
            'workspace-terminal', 'user-1', 'Workspace shell', 'workspace-1',
            '/srv/repos/project', 'workspace-shell', 7, ?, ?
          )
        `, [now, now]);
        for (const [id, name] of [
          ["direct-terminal", "Direct shell"],
          ["synthetic-chat-session", "Synthetic chat transport"],
        ] as const) {
          db.run(`
            INSERT INTO ssh_server_sessions (
              id, user_id, ssh_server_id, name, remote_session_name,
              created_at, updated_at
            ) VALUES (?, 'user-1', 'ssh-1', ?, ?, ?, ?)
          `, [id, name, `${id}-remote`, now, now]);
        }
        db.run(`
          INSERT INTO chats (
            id, user_id, name, source_kind, ssh_server_id,
            ssh_server_session_id, scope, directory, created_at, updated_at
          ) VALUES (
            'direct-chat', 'user-1', 'Investigate', 'ssh_server', 'ssh-1',
            'synthetic-chat-session', 'ssh_server', '/srv/repos', ?, ?
          )
        `, [now, now]);
        db.run(`
          INSERT INTO chat_transcript_entries (
            chat_id, user_id, entry_id, kind, timestamp, sequence, payload,
            created_at, updated_at
          ) VALUES (
            'direct-chat', 'user-1', 'message-1', 'message', ?, 1,
            '{"role":"user","content":"hello"}', ?, ?
          )
        `, [now, now, now]);
        db.run(`
          INSERT INTO chat_transcript_meta (
            chat_id, user_id, revision, entry_count, updated_at
          ) VALUES ('direct-chat', 'user-1', 'revision-1', 1, ?)
        `, [now]);
        db.run(`
          INSERT INTO vnc_sessions (
            id, user_id, ssh_server_id, remote_port, local_port, created_at,
            updated_at, status
          ) VALUES ('vnc-1', 'user-1', 'ssh-1', 5900, 15900, ?, ?, 'stopped')
        `, [now, now]);
        db.run(`
          INSERT INTO provisioning_jobs (
            id, user_id, config_json, state_json, status, workspace_id,
            created_at, updated_at, execution_host_id, execution_host_revision
          ) VALUES (
            'provision-1', 'user-1',
            '{"sshServerId":"ssh-1","targetDirectory":"/srv/repos/new"}',
            '{}', 'completed', 'workspace-1', ?, ?, 'host-ssh', 3
          )
        `, [now, now]);

        migrateCanonicalExecutionHosts(db);

        expect(db.query(`
          SELECT id, execution_host_id, execution_host_revision, server_settings
          FROM workspaces
        `).get()).toEqual({
          id: "workspace-1",
          execution_host_id: "host-ssh",
          execution_host_revision: 3,
          server_settings: '{"agent":{"provider":"copilot"}}',
        });
        expect(db.query(`
          SELECT id, workspace_id, workspace_execution_target_revision,
                 execution_host_id, execution_host_revision
          FROM terminal_sessions
          ORDER BY id
        `).all()).toEqual([
          {
            id: "direct-terminal",
            workspace_id: null,
            workspace_execution_target_revision: null,
            execution_host_id: "host-ssh",
            execution_host_revision: 3,
          },
          {
            id: "workspace-terminal",
            workspace_id: "workspace-1",
            workspace_execution_target_revision: 7,
            execution_host_id: "host-ssh",
            execution_host_revision: 3,
          },
        ]);
        expect(db.query(`
          SELECT id, source_kind, workspace_id, execution_host_id,
                 execution_host_revision
          FROM chats
        `).get()).toEqual({
          id: "direct-chat",
          source_kind: "execution_host",
          workspace_id: null,
          execution_host_id: "host-ssh",
          execution_host_revision: 3,
        });
        expect(db.query("SELECT entry_id FROM chat_transcript_entries").get()).toEqual({
          entry_id: "message-1",
        });
        expect(db.query("SELECT revision FROM chat_transcript_meta").get()).toEqual({
          revision: "revision-1",
        });
        expect(db.query(`
          SELECT execution_host_id, execution_host_revision FROM vnc_sessions
        `).get()).toEqual({
          execution_host_id: "host-ssh",
          execution_host_revision: 3,
        });
        const provisioning = db.query(`
          SELECT execution_host_id, execution_host_revision, config_json
          FROM provisioning_jobs
        `).get() as {
          execution_host_id: string;
          execution_host_revision: number;
          config_json: string;
        };
        expect(provisioning.execution_host_id).toBe("host-ssh");
        expect(provisioning.execution_host_revision).toBe(3);
        expect(JSON.parse(provisioning.config_json)).toEqual({
          targetDirectory: "/srv/repos/new",
          executionHostBinding: {
            host: { kind: "ssh", serverId: "ssh-1" },
            targetKey: "sha256:target",
            revision: 3,
          },
        });
        expect(db.query(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'ssh_server_sessions'
        `).get()).toBeNull();
        for (const tableName of [
          "workspaces",
          "terminal_sessions",
          "chats",
          "vnc_sessions",
          "provisioning_jobs",
        ]) {
          const columns = (db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
            name: string;
          }>).map((column) => column.name);
          expect(columns).not.toContain("ssh_server_id");
        }
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    });

  test("migration v46 rejects a valid resource without a canonical host", () => {
    const db = new Database(":memory:");
    const now = "2026-01-01T00:00:00.000Z";
    try {
      createCanonicalMigrationFixture(db);
      db.run(`
        INSERT INTO workspaces (
          id, user_id, name, directory, workspace_type,
          execution_target_revision, server_fingerprint, server_settings,
          created_at, updated_at
        ) VALUES (
          'unresolved-workspace', 'user-1', 'Project', '/srv/project', 'git',
          1, 'legacy-fingerprint', '{}', ?, ?
        )
      `, [now, now]);

      expect(() => migrateCanonicalExecutionHosts(db)).toThrow(
        "Cannot canonicalize workspaces with an unresolved execution host: unresolved-workspace",
      );
    } finally {
      db.close();
    }
  });

  test("migration v46 discards a VNC session without a canonical host", () => {
    const db = new Database(":memory:");
    const now = "2026-01-01T00:00:00.000Z";
    try {
      createCanonicalMigrationFixture(db);
      db.run(`
        INSERT INTO vnc_sessions (
          id, user_id, ssh_server_id, remote_port, local_port, created_at,
          updated_at, status
        ) VALUES ('orphan-vnc', 'user-1', NULL, 5900, 15900, ?, ?, 'stopped')
      `, [now, now]);

      migrateCanonicalExecutionHosts(db);

      expect(db.query("SELECT id FROM vnc_sessions").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("migration v5 creates preview sessions with the baseline status default", () => {
    const migration = migrations.find((candidate) => candidate.version === 5);
    if (!migration) {
      throw new Error("Migration v5 was not found");
    }
    const db = new Database(":memory:");
    try {
      migration.up(db);
      const columns = db.query("PRAGMA table_info(preview_sessions)").all() as Array<{
        name: string;
        dflt_value: string | null;
      }>;
      const statusColumn = columns.find((column) => column.name === "status");
      expect(statusColumn?.dflt_value).toBe("'active'");
    } finally {
      db.close();
    }
  });

  test("migration v6 adds private flags idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 6);
    if (!migration) {
      throw new Error("Migration v6 was not found");
    }
    const db = new Database(":memory:");
    try {
      for (const tableName of HISTORICAL_PRIVATE_FLAG_TABLE_NAMES) {
        db.run(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`);
      }

      migration.up(db);
      migration.up(db);

      for (const tableName of HISTORICAL_PRIVATE_FLAG_TABLE_NAMES) {
        const columns = privateFlagColumnInfo(db, tableName);
        const privateColumn = columns.find((column) => column.name === "is_private");
        expect(privateColumn?.notnull).toBe(1);
        expect(privateColumn?.dflt_value).toBe("0");
      }
    } finally {
      db.close();
    }
  });

  test("migration v7 adds queued chat messages idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 7);
    if (!migration) {
      throw new Error("Migration v7 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE chats (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = db.query("PRAGMA table_info(chats)").all() as Array<{
        name: string;
        type: string;
      }>;
      const queuedMessagesColumn = columns.find((column) => column.name === "queued_messages");
      expect(queuedMessagesColumn?.type).toBe("TEXT");
    } finally {
      db.close();
    }
  });

  test("migration v8 adds archived workspace flag idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 8);
    if (!migration) {
      throw new Error("Migration v8 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = workspaceColumnInfo(db);
      const archivedColumn = columns.find((column) => column.name === "archived");
      expect(archivedColumn?.notnull).toBe(1);
      expect(archivedColumn?.dflt_value).toBe("0");
    } finally {
      db.close();
    }
  });

  test("migration v9 adds task issue numbers idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 9);
    if (!migration) {
      throw new Error("Migration v9 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{
        name: string;
        type: string;
      }>;
      const issueNumberColumn = columns.find((column) => column.name === "issue_number");
      expect(issueNumberColumn?.type).toBe("INTEGER");
    } finally {
      db.close();
    }
  });

  test("migration v36 adds workspace types idempotently with a Git default", () => {
    const migration = migrations.find((candidate) => candidate.version === 36);
    if (!migration) {
      throw new Error("Migration v36 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");

      migration.up(db);
      migration.up(db);

      const columns = workspaceColumnInfo(db);
      const workspaceTypeColumn = columns.find((column) => column.name === "workspace_type");
      expect(workspaceTypeColumn?.notnull).toBe(1);
      expect(workspaceTypeColumn?.dflt_value).toBe("'git'");

      db.run("INSERT INTO workspaces (id) VALUES (?)", ["legacy-workspace"]);
      const row = db.query("SELECT workspace_type FROM workspaces WHERE id = ?")
        .get("legacy-workspace") as { workspace_type: string };
      expect(row.workspace_type).toBe("git");
    } finally {
      db.close();
    }
  });

  test("migration v37 adds Mesh endpoint routing columns idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 37);
    if (!migration) {
      throw new Error("Migration v37 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE mesh_node_identity (singleton INTEGER PRIMARY KEY);
        CREATE TABLE mesh_pairing_requests (id TEXT PRIMARY KEY);
        CREATE TABLE mesh_link_members (link_id TEXT, node_id TEXT);
      `);

      migration.up(db);
      migration.up(db);

      expect(
        (db.query("PRAGMA table_info(mesh_node_identity)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      ).toContain("mesh_endpoint");
      expect(
        (db.query("PRAGMA table_info(mesh_pairing_requests)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      ).toContain("target_endpoint");
      const memberColumns = db.query("PRAGMA table_info(mesh_link_members)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      expect(memberColumns).toContainEqual(expect.objectContaining({
        name: "endpoint_source",
        notnull: 1,
        dflt_value: "'advertised'",
      }));
    } finally {
      db.close();
    }
  });

  test("migration v10 converts legacy settings and task modes idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 10);
    if (!migration) {
      throw new Error("Migration v10 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          server_settings TEXT
        )
      `);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "legacy-ssh",
        JSON.stringify({ mode: "connect", hostname: "agent.example", port: 2222, password: "secret" }),
      ]);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "legacy-agent",
        JSON.stringify({
          agent: { provider: "copilot", transport: "ssh" },
          execution: { host: "runner.example", port: 2200, user: "runner" },
        }),
      ]);
      const currentServerSettings = JSON.stringify({ agent: { provider: "codex", transport: "stdio" } });
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "current",
        currentServerSettings,
      ]);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "default-settings",
        JSON.stringify({}),
      ]);
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, mode TEXT)");
      db.run("INSERT INTO tasks (id, mode) VALUES (?, ?)", ["legacy-task", "agent"]);
      db.run("INSERT INTO tasks (id, mode) VALUES (?, ?)", ["current-task", "task"]);

      migration.up(db);
      migration.up(db);

      const legacySsh = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("legacy-ssh") as {
        server_settings: string;
      };
      expect(JSON.parse(legacySsh.server_settings)).toEqual({
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "agent.example",
          port: 2222,
          password: "secret",
        },
      });

      const legacyAgent = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("legacy-agent") as {
        server_settings: string;
      };
      expect(JSON.parse(legacyAgent.server_settings)).toEqual({
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "runner.example",
          port: 2200,
          username: "runner",
        },
      });

      const current = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("current") as {
        server_settings: string;
      };
      expect(current.server_settings).toBe(currentServerSettings);

      const defaultSettings = db.query("SELECT server_settings FROM workspaces WHERE id = ?").get("default-settings") as {
        server_settings: string;
      };
      expect(JSON.parse(defaultSettings.server_settings)).toEqual({
        agent: { provider: "opencode" },
      });

      const taskModes = db.query("SELECT id, mode FROM tasks ORDER BY id").all() as Array<{
        id: string;
        mode: string;
      }>;
      expect(taskModes).toEqual([
        { id: "current-task", mode: "task" },
        { id: "legacy-task", mode: "task" },
      ]);
    } finally {
      db.close();
    }
  });

  test("migration v10 adds a missing task mode column", () => {
    const migration = migrations.find((candidate) => candidate.version === 10);
    if (!migration) {
      throw new Error("Migration v10 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      db.run("INSERT INTO tasks (id) VALUES (?)", ["missing-mode"]);

      migration.up(db);
      migration.up(db);

      const task = db.query("SELECT mode FROM tasks WHERE id = ?").get("missing-mode") as { mode: string };
      expect(task.mode).toBe("task");
      const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "mode")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("migration v11 adds the Clanky context toggle idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 11);
    if (!migration) {
      throw new Error("Migration v11 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
      db.run("INSERT INTO workspaces (id) VALUES (?)", ["legacy-workspace"]);

      migration.up(db);
      migration.up(db);

      const column = (db.query("PRAGMA table_info(workspaces)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((candidate) => candidate.name === "allow_clanky_context");
      expect(column?.notnull).toBe(1);
      expect(column?.dflt_value).toBe("0");
      expect(
        (db.query("SELECT allow_clanky_context FROM workspaces WHERE id = ?").get("legacy-workspace") as {
          allow_clanky_context: number;
        }).allow_clanky_context,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("migration v33 assigns stdio ownership and clears SSH ownership idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 33);
    if (!migration) {
      throw new Error("Migration v33 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          server_settings TEXT,
          execution_node_id TEXT
        );
        CREATE TABLE mesh_node_identity (
          singleton INTEGER PRIMARY KEY,
          node_id TEXT NOT NULL
        );
      `);
      db.run("INSERT INTO mesh_node_identity (singleton, node_id) VALUES (1, ?)", ["local-node"]);
      db.run("INSERT INTO workspaces (id, server_settings) VALUES (?, ?)", [
        "stdio-workspace",
        JSON.stringify({ agent: { transport: "stdio" } }),
      ]);
      db.run("INSERT INTO workspaces (id, server_settings, execution_node_id) VALUES (?, ?, ?)", [
        "ssh-workspace",
        JSON.stringify({ agent: { transport: "ssh" } }),
        "stale-node",
      ]);

      migration.up(db);
      migration.up(db);

      expect(
        (db.query("SELECT execution_node_id FROM workspaces WHERE id = ?").get("stdio-workspace") as {
          execution_node_id: string | null;
        }).execution_node_id,
      ).toBe("local-node");
      expect(
        (db.query("SELECT execution_node_id FROM workspaces WHERE id = ?").get("ssh-workspace") as {
          execution_node_id: string | null;
        }).execution_node_id,
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  test("migration v12 creates managed context-key associations idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 12);
    if (!migration) {
      throw new Error("Migration v12 was not found");
    }
    const db = new Database(":memory:");
    try {
      migration.up(db);
      migration.up(db);

      const columns = db.query("PRAGMA table_info(clanky_context_api_keys)").all() as Array<{
        name: string;
        pk: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        "user_id",
        "workspace_id",
        "context_type",
        "context_id",
        "api_key_id",
        "generation",
        "created_at",
        "revoked_at",
      ]);
      expect(columns.map((column) => column.pk)).toEqual([1, 2, 3, 4, 0, 5, 0, 0]);
      const insert = db.prepare(`
        INSERT INTO clanky_context_api_keys (
          user_id, workspace_id, context_type, context_id, api_key_id,
          generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run("user-1", "workspace-a", "chat", "context-1", "key-a", 1, "2026-01-01T00:00:00.000Z");
      insert.run("user-1", "workspace-b", "chat", "context-1", "key-b", 1, "2026-01-01T00:00:00.000Z");
      expect(
        (db.query("SELECT COUNT(*) AS count FROM clanky_context_api_keys").get() as { count: number }).count,
      ).toBe(2);
      const indexes = db.query("PRAGMA index_list(clanky_context_api_keys)").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        "idx_clanky_context_api_keys_context",
        "idx_clanky_context_api_keys_workspace",
      ]));
    } finally {
      db.close();
    }
  });

  test("migration v17 removes legacy transcript columns only after normalized data is complete", () => {
    const migration = migrations.find((candidate) => candidate.version === 17);
    if (!migration) {
      throw new Error("Migration v17 was not found");
    }

    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          messages TEXT,
          logs TEXT,
          tool_calls TEXT
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          messages TEXT,
          logs TEXT,
          tool_calls TEXT
        );
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          messages TEXT,
          logs TEXT,
          tool_calls TEXT
        );
        CREATE TABLE chat_transcript_meta (
          chat_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE task_transcript_meta (
          task_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE agent_run_transcript_meta (
          agent_run_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          entry_count INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_transcript_entries (chat_id TEXT NOT NULL, entry_id TEXT NOT NULL);
        CREATE TABLE task_transcript_entries (task_id TEXT NOT NULL, entry_id TEXT NOT NULL);
        CREATE TABLE agent_run_transcript_entries (agent_run_id TEXT NOT NULL, entry_id TEXT NOT NULL);
        INSERT INTO chats VALUES ('chat-1', 'user-1', '{}', '{}', '{}');
        INSERT INTO tasks VALUES ('task-1', 'user-1', '{}', '{}', '{}');
        INSERT INTO agent_runs VALUES ('run-1', 'user-1', '{}', '{}', '{}');
        INSERT INTO chat_transcript_meta VALUES ('chat-1', 'user-1', 'chat-rev', 1, 'now');
        INSERT INTO task_transcript_meta VALUES ('task-1', 'user-1', 'task-rev', 0, 'now');
        INSERT INTO agent_run_transcript_meta VALUES ('run-1', 'user-1', 'run-rev', 0, 'now');
        INSERT INTO chat_transcript_entries VALUES ('chat-1', 'message:1');
      `);

      migration.up(db);
      migration.up(db);

      for (const tableName of ["chats", "tasks", "agent_runs"]) {
        const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).not.toEqual(
          expect.arrayContaining(["messages", "logs", "tool_calls"]),
        );
      }
    } finally {
      db.close();
    }
  });

  test("migration v17 fails before dropping columns when normalized data is incomplete", () => {
    const migration = migrations.find((candidate) => candidate.version === 17);
    if (!migration) {
      throw new Error("Migration v17 was not found");
    }

    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, messages TEXT, logs TEXT, tool_calls TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, messages TEXT, logs TEXT, tool_calls TEXT);
        CREATE TABLE agent_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, messages TEXT, logs TEXT, tool_calls TEXT);
        CREATE TABLE chat_transcript_meta (chat_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision TEXT NOT NULL, entry_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE task_transcript_meta (task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision TEXT NOT NULL, entry_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE agent_run_transcript_meta (agent_run_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision TEXT NOT NULL, entry_count INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE chat_transcript_entries (chat_id TEXT NOT NULL, entry_id TEXT NOT NULL);
        CREATE TABLE task_transcript_entries (task_id TEXT NOT NULL, entry_id TEXT NOT NULL);
        CREATE TABLE agent_run_transcript_entries (agent_run_id TEXT NOT NULL, entry_id TEXT NOT NULL);
        INSERT INTO chats VALUES ('chat-1', 'user-1', '{}', '{}', '{}');
        INSERT INTO tasks VALUES ('task-1', 'user-1', '{}', '{}', '{}');
        INSERT INTO agent_runs VALUES ('run-1', 'user-1', '{}', '{}', '{}');
        INSERT INTO chat_transcript_meta VALUES ('chat-1', 'user-1', 'chat-rev', 0, 'now');
        INSERT INTO agent_run_transcript_meta VALUES ('run-1', 'user-1', 'run-rev', 0, 'now');
      `);

      expect(() => migration.up(db)).toThrow("normalized transcript is incomplete");
      const columns = db.query("PRAGMA table_info(chats)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["messages", "logs", "tool_calls"]),
      );
    } finally {
      db.close();
    }
  });

  test("migration v18 runs database compaction once outside a transaction", async () => {
    const migration = migrations.find((candidate) => candidate.version === 18);
    if (!migration) {
      throw new Error("Migration v18 was not found");
    }

    const dataDir = await mkdtemp(join(tmpdir(), "clanky-db-vacuum-"));
    const dbPath = join(dataDir, "database.sqlite");
    const db = new Database(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE preserved (value TEXT NOT NULL);
        CREATE TABLE payload (value BLOB NOT NULL);
        INSERT INTO preserved VALUES ('kept');
      `);
      db.run("INSERT INTO payload VALUES (?)", [new Uint8Array(2 * 1024 * 1024)]);
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      db.run("DELETE FROM payload");
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const sizeBeforeVacuum = Bun.file(dbPath).size;
      expect((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBeGreaterThan(0);

      const insertMigration = db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      );
      for (const candidate of migrations) {
        if (candidate.version !== migration.version) {
          insertMigration.run(candidate.version, candidate.name, "now");
        }
      }

      expect(migration.transactional).toBe(false);
      expect(runMigrations(db)).toBe(1);
      expect((db.query("SELECT value FROM preserved").get() as { value: string }).value).toBe("kept");
      expect(Bun.file(dbPath).size).toBeLessThan(sizeBeforeVacuum);
      expect((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count).toBe(0);
      expect(runMigrations(db)).toBe(0);
      expect(getSchemaVersion(db)).toBe(migrations.at(-1)?.version ?? 0);
    } finally {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("mesh migrations create pairing tables and are idempotent", () => {
    const identityMigration = migrations.find((candidate) => candidate.version === 20);
    const directionMigration = migrations.find((candidate) => candidate.version === 21);
    const approvalMigration = migrations.find((candidate) => candidate.version === 22);
    const syncMigration = migrations.find((candidate) => candidate.version === 23);
    const memberSnapshotMigration = migrations.find((candidate) => candidate.version === 24);
    const claimsMigration = migrations.find((candidate) => candidate.version === 25);
    const signatureMigration = migrations.find((candidate) => candidate.version === 26);
    const authorityMigration = migrations.find((candidate) => candidate.version === 27);
    const encryptionMigration = migrations.find((candidate) => candidate.version === 28);
    const pairingEncryptionMigration = migrations.find((candidate) => candidate.version === 29);
    const pairingRequestEncryptionMigration = migrations.find((candidate) => candidate.version === 30);
    const pairingTargetLinkMigration = migrations.find((candidate) => candidate.version === 31);
    const instanceNamesMigration = migrations.find((candidate) => candidate.version === 32);
    const transportOnlyMigration = migrations.find((candidate) => candidate.version === 35);
    if (
      !identityMigration ||
      !directionMigration ||
      !approvalMigration ||
      !syncMigration ||
      !memberSnapshotMigration ||
      !claimsMigration ||
      !signatureMigration ||
      !authorityMigration ||
      !encryptionMigration ||
      !pairingEncryptionMigration ||
      !pairingRequestEncryptionMigration ||
      !pairingTargetLinkMigration ||
      !instanceNamesMigration ||
      !transportOnlyMigration
    ) {
      throw new Error("Mesh migrations were not found");
    }

    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE webapp_users (
          id TEXT PRIMARY KEY
        );
      `);
      identityMigration.up(db);
      directionMigration.up(db);
      directionMigration.up(db);
      approvalMigration.up(db);
      approvalMigration.up(db);
      syncMigration.up(db);
      syncMigration.up(db);
      memberSnapshotMigration.up(db);
      memberSnapshotMigration.up(db);

      const pairingColumns = db.query("PRAGMA table_info(mesh_pairing_requests)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const direction = pairingColumns.find((column) => column.name === "direction");
      expect(direction?.notnull).toBe(1);
      expect(direction?.dflt_value).toBe("'incoming'");
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_links'").get()).toBeTruthy();
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_pairing_approvals'").get()).toBeTruthy();
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_sync_outbox'").get()).toBeTruthy();
      const approvalColumns = db.query("PRAGMA table_info(mesh_pairing_approvals)").all() as Array<{ name: string }>;
      expect(approvalColumns.map((column) => column.name)).toContain("members_json");
      claimsMigration.up(db);
      claimsMigration.up(db);
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_link_claims'").get()).toBeTruthy();
      signatureMigration.up(db);
      signatureMigration.up(db);
      const claimColumns = db.query("PRAGMA table_info(mesh_link_claims)").all() as Array<{ name: string }>;
      expect(claimColumns.map((column) => column.name)).toContain("signature");
      authorityMigration.up(db);
      authorityMigration.up(db);
      const authorityColumns = db.query("PRAGMA table_info(mesh_pairing_approvals)").all() as Array<{ name: string }>;
      expect(authorityColumns.map((column) => column.name)).toContain("active_node_id");
      expect(authorityColumns.map((column) => column.name)).toContain("takeover_generation");
      encryptionMigration.up(db);
      encryptionMigration.up(db);
      const identityColumns = db.query("PRAGMA table_info(mesh_node_identity)").all() as Array<{ name: string }>;
      expect(identityColumns.map((column) => column.name)).toContain("encryption_public_key");
      pairingEncryptionMigration.up(db);
      pairingEncryptionMigration.up(db);
      const pairingEncryptionColumns = db.query("PRAGMA table_info(mesh_pairing_approvals)").all() as Array<{ name: string }>;
      expect(pairingEncryptionColumns.map((column) => column.name)).toContain("encryption_public_key");
      pairingRequestEncryptionMigration.up(db);
      pairingRequestEncryptionMigration.up(db);
      pairingTargetLinkMigration.up(db);
      pairingTargetLinkMigration.up(db);
      instanceNamesMigration.up(db);
      instanceNamesMigration.up(db);
      const pairingRequestColumns = db.query("PRAGMA table_info(mesh_pairing_requests)").all() as Array<{ name: string }>;
      expect(pairingRequestColumns.map((column) => column.name)).toContain("target_link_id");
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, execution_node_id TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT);
        CREATE TABLE review_comments (id TEXT PRIMARY KEY, task_id TEXT);
        CREATE TABLE sessions (task_id TEXT PRIMARY KEY);
        CREATE TABLE clanky_context_api_keys (workspace_id TEXT);
        CREATE TABLE task_transcript_entries (task_id TEXT);
        CREATE TABLE task_transcript_meta (task_id TEXT);
        CREATE TABLE chats (id TEXT PRIMARY KEY, workspace_id TEXT);
        CREATE TABLE chat_transcript_entries (chat_id TEXT);
        CREATE TABLE chat_transcript_meta (chat_id TEXT);
        CREATE TABLE ssh_sessions (id TEXT PRIMARY KEY, workspace_id TEXT);
        CREATE TABLE preview_sessions (id TEXT PRIMARY KEY, workspace_id TEXT);
        CREATE TABLE agents (id TEXT PRIMARY KEY, workspace_id TEXT);
        CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT);
        CREATE TABLE agent_run_transcript_entries (agent_run_id TEXT);
        CREATE TABLE agent_run_transcript_meta (agent_run_id TEXT);
        INSERT INTO webapp_users (id) VALUES ('local-user');
        INSERT INTO mesh_node_identity (
          singleton, node_id, instance_name, public_key, fingerprint,
          encryption_public_key, created_at, updated_at
        ) VALUES (
          1, 'local-node', 'Local', 'local-key', 'identity-fingerprint',
          NULL, 'now', 'now'
        );
        INSERT INTO workspaces VALUES
          ('local-workspace', 'local-node'),
          ('remote-workspace', 'remote-node');
        INSERT INTO tasks VALUES
          ('local-task', 'local-workspace'),
          ('remote-task', 'remote-workspace');
        INSERT INTO review_comments VALUES
          ('local-review', 'local-task'),
          ('remote-review', 'remote-task');
        INSERT INTO sessions VALUES ('local-task'), ('remote-task');
        INSERT INTO clanky_context_api_keys VALUES ('local-workspace'), ('remote-workspace');
        INSERT INTO task_transcript_entries VALUES ('local-task'), ('remote-task');
        INSERT INTO task_transcript_meta VALUES ('local-task'), ('remote-task');
        INSERT INTO chats VALUES
          ('local-chat', 'local-workspace'),
          ('remote-chat', 'remote-workspace');
        INSERT INTO chat_transcript_entries VALUES ('local-chat'), ('remote-chat');
        INSERT INTO chat_transcript_meta VALUES ('local-chat'), ('remote-chat');
        INSERT INTO ssh_sessions VALUES
          ('local-ssh', 'local-workspace'),
          ('remote-ssh', 'remote-workspace');
        INSERT INTO preview_sessions VALUES
          ('local-preview', 'local-workspace'),
          ('remote-preview', 'remote-workspace');
        INSERT INTO agents VALUES
          ('local-agent', 'local-workspace'),
          ('remote-agent', 'remote-workspace');
        INSERT INTO agent_runs VALUES
          ('local-run', 'local-agent'),
          ('remote-run', 'remote-agent');
        INSERT INTO agent_run_transcript_entries VALUES ('local-run'), ('remote-run');
        INSERT INTO agent_run_transcript_meta VALUES ('local-run'), ('remote-run');
        INSERT INTO mesh_nodes (
          node_id, instance_name, public_key, fingerprint, encryption_public_key,
          endpoint, transport, status, last_seen_at, created_at, updated_at
        ) VALUES
          ('local-node', 'Local', 'local-key', 'local-fingerprint', NULL,
            'http://local.test', 'http', 'active', NULL, 'now', 'now'),
          ('remote-node', 'Remote', 'remote-key', 'remote-fingerprint', NULL,
            'http://remote.test', 'http', 'active', NULL, 'now', 'now');
        INSERT INTO mesh_links (
          link_id, local_user_id, active_node_id, takeover_generation,
          active_claimed_at, active_claim_origin, status, created_at, updated_at
        ) VALUES ('link-1', 'local-user', 'local-node', 2, 'now', 'test', 'conflict', 'now', 'now');
        INSERT INTO mesh_link_members (
          link_id, node_id, local_user_id, endpoint, transport, status,
          membership_generation, last_seen_at, created_at, updated_at
        ) VALUES
          ('link-1', 'local-node', 'local-user', 'http://local.test', 'http', 'active', 1, 'now', 'now', 'now'),
          ('link-1', 'remote-node', 'remote-user', 'http://remote.test', 'http', 'active', 1, 'now', 'now', 'now');
        INSERT INTO mesh_pairing_requests (
          id, direction, link_id, target_link_id, target_local_user_id,
          requested_node_id, requested_instance_name, requested_local_user_id,
          requested_username, endpoint, transport, public_key, fingerprint,
          encryption_public_key, nonce, signature, status, expires_at,
          approved_at, approved_by_user_id, rejection_reason, created_at, updated_at
        ) VALUES (
          'request-1', 'outgoing', 'link-1', NULL, NULL,
          'remote-node', 'Remote', 'remote-user', 'remote',
          'http://remote.test', 'http', 'remote-key', 'remote-fingerprint',
          NULL, 'nonce-1', 'request-signature', 'approved', 'later',
          'now', 'local-user', NULL, 'now', 'now'
        );
        INSERT INTO mesh_pairing_approvals (
          request_id, link_id, approved_by_node_id, approved_by_instance_name,
          approved_by_local_user_id, active_node_id, takeover_generation,
          endpoint, transport, public_key, fingerprint, encryption_public_key,
          signature, members_json, status, created_at, updated_at
        ) VALUES (
          'request-1', 'link-1', 'remote-node', 'Remote', 'remote-user',
          'local-node', 2, 'http://remote.test', 'http', 'remote-key',
          'remote-fingerprint', NULL, 'approval-signature', '[]',
          'accepted', 'now', 'now'
        );
      `);
      transportOnlyMigration.up(db);
      transportOnlyMigration.up(db);
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_sync_outbox'").get()).toBeNull();
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_link_claims'").get()).toBeNull();
      const finalLinkColumns = db.query("PRAGMA table_info(mesh_links)").all() as Array<{ name: string }>;
      expect(finalLinkColumns.map((column) => column.name)).not.toContain("active_node_id");
      expect(finalLinkColumns.map((column) => column.name)).not.toContain("takeover_generation");
      const finalApprovalColumns = db.query("PRAGMA table_info(mesh_pairing_approvals)").all() as Array<{ name: string }>;
      expect(finalApprovalColumns.map((column) => column.name)).not.toContain("active_node_id");
      expect(finalApprovalColumns.map((column) => column.name)).not.toContain("takeover_generation");
      expect(db.query("SELECT status FROM mesh_links WHERE link_id = 'link-1'").get())
        .toEqual({ status: "active" });
      expect(db.query("SELECT status FROM mesh_pairing_approvals WHERE request_id = 'request-1'").get())
        .toEqual({ status: "accepted" });
      expect(db.query("SELECT id FROM workspaces ORDER BY id").all())
        .toEqual([{ id: "local-workspace" }]);
      for (const [tableName, remoteId] of [
        ["tasks", "remote-task"],
        ["review_comments", "remote-review"],
        ["sessions", "remote-task"],
        ["chats", "remote-chat"],
        ["ssh_sessions", "remote-ssh"],
        ["preview_sessions", "remote-preview"],
        ["agents", "remote-agent"],
        ["agent_runs", "remote-run"],
      ] as const) {
        const idColumn = tableName === "sessions" ? "task_id" : "id";
        expect(db.query(`SELECT 1 FROM ${tableName} WHERE ${idColumn} = ?`).get(remoteId)).toBeNull();
      }
      expect(db.query("SELECT 1 FROM clanky_context_api_keys WHERE workspace_id = 'remote-workspace'").get())
        .toBeNull();
      expect(db.query("SELECT 1 FROM task_transcript_entries WHERE task_id = 'remote-task'").get())
        .toBeNull();
      expect(db.query("SELECT 1 FROM chat_transcript_entries WHERE chat_id = 'remote-chat'").get())
        .toBeNull();
      expect(db.query("SELECT 1 FROM agent_run_transcript_entries WHERE agent_run_id = 'remote-run'").get())
        .toBeNull();
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("keeps the canonical terminal session schema when migration v38 is replayed", async () => {
    await withTempDataDir(async () => {
      await initializeDatabase();
      const db = getDatabase();

      // Verify terminal_sessions table exists from baseline
      expect(tableNames()).toContain("terminal_sessions");
      const cols = (db.query("PRAGMA table_info(terminal_sessions)").all() as Array<{ name: string }>).map((r) => r.name);
      expect(cols).not.toContain("target_transport");
      expect(cols).not.toContain("target_hostname");
      expect(cols).not.toContain("target_port");
      expect(cols).not.toContain("target_username");
      expect(cols).not.toContain("target_execution_node_id");
      expect(cols).toContain("task_id");
      expect(cols).toContain("connection_mode");
      expect(cols).toContain("is_private");
      expect(cols).toContain("execution_host_id");
      expect(cols).toContain("execution_host_revision");

      // Migration v38 is idempotent on clean databases
      const migration = migrations.find((m) => m.version === 38);
      if (!migration) {
        throw new Error("Migration v38 was not found");
      }
      migration.up(db);
      expect(tableNames()).toContain("terminal_sessions");
    });
  });

  test("migration v38 fails if ssh_sessions contains rows", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    // Create minimal ssh_sessions and workspaces for testing
    db.run(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        directory TEXT NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE ssh_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      )
    `);
    db.run("INSERT INTO workspaces (id, user_id, name, directory) VALUES ('w1', 'u1', 'W1', '/tmp')");
    db.run("INSERT INTO ssh_sessions (id, user_id, workspace_id) VALUES ('s1', 'u1', 'w1')");

    const migration = migrations.find((m) => m.version === 38);
    if (!migration) {
      throw new Error("Migration v38 was not found");
    }
    expect(() => migration.up(db)).toThrow(/ssh_sessions still contains/);
    db.close();
  });

  test("migration v39 normalizes legacy managed context types idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 39);
    if (!migration) {
      throw new Error("Migration v39 was not found");
    }
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE clanky_context_api_keys (
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          context_type TEXT NOT NULL,
          context_id TEXT NOT NULL,
          api_key_id TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          PRIMARY KEY (user_id, workspace_id, context_type, context_id, generation)
        )
      `);
      db.run(`
        INSERT INTO clanky_context_api_keys (
          user_id, workspace_id, context_type, context_id, api_key_id, generation, created_at
        ) VALUES
          ('user-1', 'workspace-1', 'ssh_session', 'legacy-session', 'key-1', 1, '2026-01-01T00:00:00.000Z'),
          ('user-1', 'workspace-1', 'terminal_session', 'current-session', 'key-2', 1, '2026-01-01T00:00:00.000Z'),
          ('user-1', 'workspace-1', 'chat', 'chat-1', 'key-3', 1, '2026-01-01T00:00:00.000Z')
      `);

      migration.up(db);
      migration.up(db);

      expect(
        db.query(`
          SELECT context_id, context_type
          FROM clanky_context_api_keys
          ORDER BY context_id
        `).all(),
      ).toEqual([
        { context_id: "chat-1", context_type: "chat" },
        { context_id: "current-session", context_type: "terminal_session" },
        { context_id: "legacy-session", context_type: "terminal_session" },
      ]);
    } finally {
      db.close();
    }
  });

  test("migration v47 separates registered provisioning hosts and creates incomplete SSH targets idempotently", () => {
    const migration = migrations.find((candidate) => candidate.version === 47);
    if (!migration) {
      throw new Error("Migration v47 was not found");
    }

    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.exec(`
        CREATE TABLE execution_hosts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          target_key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          directory TEXT NOT NULL,
          source_directory TEXT,
          execution_host_id TEXT,
          execution_host_revision INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chats (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          workspace_id TEXT,
          execution_host_id TEXT,
          execution_host_revision INTEGER
        );
        CREATE TABLE terminal_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          workspace_id TEXT,
          execution_host_id TEXT,
          execution_host_revision INTEGER
        );
      `);
      db.exec(`
        INSERT INTO execution_hosts (
          id, user_id, kind, source_id, target_key, revision, revoked_at, created_at, updated_at
        ) VALUES
          ('host-ssh', 'user-1', 'ssh', 'server-1', 'ssh:old-host:22:builder', 3, NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('host-local', 'user-1', 'local', 'node-1', 'local:node-1', 1, NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO workspaces (
          id, user_id, name, directory, source_directory, execution_host_id,
          execution_host_revision, created_at, updated_at
        ) VALUES
          ('workspace-ssh', 'user-1', 'SSH workspace', '/workspaces/ssh',
            '/sources/ssh', 'host-ssh', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('workspace-local', 'user-1', 'Local workspace', '/workspaces/local',
            '/sources/local', 'host-local', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO chats (id, user_id, workspace_id, execution_host_id, execution_host_revision)
          VALUES ('chat-ssh', 'user-1', 'workspace-ssh', 'host-ssh', 3);
        INSERT INTO terminal_sessions (
          id, user_id, workspace_id, execution_host_id, execution_host_revision
        ) VALUES ('terminal-ssh', 'user-1', 'workspace-ssh', 'host-ssh', 3);
      `);

      migration.up(db);
      migration.up(db);

      const workspace = db.query(`
        SELECT execution_host_id, execution_host_revision,
          provisioning_host_id, provisioning_host_revision
        FROM workspaces
        WHERE id = 'workspace-ssh'
      `).get() as {
        execution_host_id: string;
        execution_host_revision: number;
        provisioning_host_id: string;
        provisioning_host_revision: number;
      };
      expect(workspace.provisioning_host_id).toBe("host-ssh");
      expect(workspace.provisioning_host_revision).toBe(3);
      expect(workspace.execution_host_id).not.toBe("host-ssh");
      expect(workspace.execution_host_revision).toBe(1);

      const directHost = db.query(`
        SELECT kind, source_id, target_key, revision
        FROM execution_hosts
        WHERE id = ?
      `).get(workspace.execution_host_id) as {
        kind: string;
        source_id: string;
        target_key: string;
        revision: number;
      };
      expect(directHost).toEqual({
        kind: "ssh",
        source_id: "workspace-target:workspace-ssh",
        target_key: "workspace-target-missing:workspace-ssh",
        revision: 1,
      });

      const target = db.query(`
        SELECT host, port, username, password_ciphertext, target_key, revision
        FROM workspace_execution_targets
        WHERE workspace_id = 'workspace-ssh'
      `).get();
      expect(target).toEqual({
        host: null,
        port: null,
        username: null,
        password_ciphertext: null,
        target_key: "workspace-target-missing:workspace-ssh",
        revision: 1,
      });

      expect(db.query(`
        SELECT execution_host_id, execution_host_revision
        FROM chats
        WHERE id = 'chat-ssh'
      `).get()).toEqual({
        execution_host_id: workspace.execution_host_id,
        execution_host_revision: 1,
      });
      expect(db.query(`
        SELECT execution_host_id, execution_host_revision
        FROM terminal_sessions
        WHERE id = 'terminal-ssh'
      `).get()).toEqual({
        execution_host_id: workspace.execution_host_id,
        execution_host_revision: 1,
      });

      const localWorkspace = db.query(`
        SELECT execution_host_id, provisioning_host_id
        FROM workspaces
        WHERE id = 'workspace-local'
      `).get();
      expect(localWorkspace).toEqual({
        execution_host_id: "host-local",
        provisioning_host_id: null,
      });
      expect(
        db.query("SELECT COUNT(*) AS count FROM workspace_execution_targets").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
