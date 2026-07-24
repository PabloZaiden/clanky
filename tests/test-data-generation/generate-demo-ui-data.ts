/**
 * Materialize the versioned demo UI seed into a runtime data directory and,
 * unless disabled, apply it to the SQLite database.
 *
 * Usage:
 *   bun tests/test-data-generation/generate-demo-ui-data.ts
 *   bun tests/test-data-generation/generate-demo-ui-data.ts --skip-apply
 *   bun tests/test-data-generation/generate-demo-ui-data.ts --data-dir ./tmp/demo-data
 */

import { mkdir } from "fs/promises";
import { join, resolve } from "path";

interface DatabaseModule {
  closeDatabase: () => void;
  getDatabase: () => {
    exec: (sql: string) => void;
    query: (sql: string) => { all: () => unknown[] };
    run: (sql: string) => void;
  };
  initializeDatabase: () => Promise<void>;
}

interface CliOptions {
  dataDir: string;
  applySeed: boolean;
}

const DEMO_OWNER_USER_ID = "admin";
const USER_OWNED_SEED_TABLES = [
  "ssh_servers",
  "ssh_server_sessions",
  "workspaces",
  "ssh_sessions",
  "tasks",
  "chats",
  "agents",
  "review_comments",
  "preview_sessions",
] as const;

type SeedTranscriptResource = "chat" | "task" | "agent_run";

interface SeedTranscript {
  resource: SeedTranscriptResource;
  resourceId: string;
  userId: string;
  messages: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  toolCalls: Array<Record<string, unknown>>;
}

function splitSqlList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "'") {
      if (inString && value[index + 1] === "'") {
        index++;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "(") {
      depth++;
    } else if (character === ")") {
      depth--;
    } else if (character === "," && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  items.push(value.slice(start).trim());
  return items;
}

function findSqlClosingParen(sql: string, openingIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let index = openingIndex; index < sql.length; index++) {
    const character = sql[index];
    if (character === "'") {
      if (inString && sql[index + 1] === "'") {
        index++;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "(") {
      depth++;
    } else if (character === ")") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error("Unclosed SQL parenthesized expression in demo seed");
}

function findSqlStatementEnd(sql: string, startIndex: number): number {
  let inString = false;
  for (let index = startIndex; index < sql.length; index++) {
    const character = sql[index];
    if (character === "'") {
      if (inString && sql[index + 1] === "'") {
        index++;
      } else {
        inString = !inString;
      }
    } else if (character === ";" && !inString) {
      return index;
    }
  }
  throw new Error("Unterminated SQL statement in demo seed");
}

function parseSqlLiteral(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "NULL") {
    return null;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseJsonArray(value: string, fieldName: string): Array<Record<string, unknown>> {
  const parsed = parseSqlLiteral(value);
  if (parsed === null || parsed === "") {
    return [];
  }
  if (typeof parsed !== "string") {
    throw new Error(`Demo seed transcript field ${fieldName} must be JSON text`);
  }
  const result: unknown = JSON.parse(parsed);
  if (!Array.isArray(result)) {
    throw new Error(`Demo seed transcript field ${fieldName} must be an array`);
  }
  return result.filter((item): item is Record<string, unknown> => (
    item !== null && typeof item === "object" && !Array.isArray(item)
  ));
}

function sqlString(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) {
    return "NULL";
  }
  return `'${serialized.replaceAll("'", "''")}'`;
}

function transcriptInsertStatements(transcript: SeedTranscript): string {
  const entries = [
    ...transcript.messages.map((payload, order) => ({
      kind: "message" as const,
      id: String(payload["id"]),
      timestamp: String(payload["timestamp"]),
      payload,
      order,
    })),
    ...transcript.toolCalls.map((payload, order) => ({
      kind: "tool" as const,
      id: String(payload["id"]),
      timestamp: String(payload["timestamp"]),
      payload,
      order: transcript.messages.length + order,
    })),
    ...transcript.logs.map((payload, order) => ({
      kind: "log" as const,
      id: String(payload["id"]),
      timestamp: String(payload["timestamp"]),
      payload,
      order: transcript.messages.length + transcript.toolCalls.length + order,
    })),
  ].sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    return byTimestamp !== 0 ? byTimestamp : left.order - right.order;
  });
  const tablePrefix = transcript.resource === "task" ? "task" : transcript.resource;
  const entriesTable = `${tablePrefix}_transcript_entries`;
  const resourceColumn = `${transcript.resource}_id`;
  const metaTable = `${tablePrefix}_transcript_meta`;
  const statements = entries.map((entry, sequence) => {
    const tool = entry.kind === "tool" ? entry.payload : null;
    const values = [
      transcript.resourceId,
      transcript.userId,
      `${entry.kind}:${entry.id}`,
      entry.kind,
      entry.timestamp,
      sequence,
      tool ? {} : entry.payload,
      tool?.["name"] ?? null,
      tool?.["status"] ?? null,
      tool && tool["input"] !== undefined ? JSON.stringify(tool["input"]) : null,
      tool && tool["output"] !== undefined ? JSON.stringify(tool["output"]) : null,
      tool && tool["extras"] !== undefined ? JSON.stringify(tool["extras"]) : null,
      "demo-seed",
      "demo-seed",
    ];
    return `INSERT INTO ${entriesTable} (
  ${resourceColumn}, user_id, entry_id, kind, timestamp, sequence,
  payload, tool_name, tool_status, tool_input, tool_output, tool_extras,
  created_at, updated_at
) VALUES (
  ${values.map(sqlString).join(",\n  ")}
)
ON CONFLICT(${resourceColumn}, entry_id) DO UPDATE SET
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
  updated_at = excluded.updated_at;`;
  });
  statements.push(`INSERT INTO ${metaTable} (
  ${resourceColumn}, user_id, revision, entry_count, updated_at
) VALUES (
  ${sqlString(transcript.resourceId)},
  ${sqlString(transcript.userId)},
  ${sqlString(`demo-seed:${entries.length}`)},
  ${entries.length},
  ${sqlString("demo-seed")}
)
ON CONFLICT(${resourceColumn}) DO UPDATE SET
  user_id = excluded.user_id,
  revision = excluded.revision,
  entry_count = excluded.entry_count,
  updated_at = excluded.updated_at;`);
  return statements.join("\n\n");
}

function removeLegacyTranscriptFields(sql: string): string {
  const transcripts: SeedTranscript[] = [];
  const insertPattern = /INSERT INTO (tasks|chats|agent_runs) \(/g;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = insertPattern.exec(sql)) !== null) {
    const sourceTable = match[1]!;
    const resource: SeedTranscriptResource = sourceTable === "tasks"
      ? "task"
      : sourceTable === "agent_runs"
        ? "agent_run"
        : "chat";
    const statementStart = match.index;
    const columnsOpen = statementStart + match[0].length - 1;
    const columnsClose = findSqlClosingParen(sql, columnsOpen);
    const valuesMarker = sql.indexOf("VALUES (", columnsClose);
    if (valuesMarker < 0) {
      throw new Error(`Missing VALUES clause for ${resource} demo seed row`);
    }
    const valuesOpen = valuesMarker + "VALUES ".length;
    const valuesClose = findSqlClosingParen(sql, valuesOpen);
    const statementEnd = findSqlStatementEnd(sql, valuesClose + 1);
    const columns = splitSqlList(sql.slice(columnsOpen + 1, columnsClose));
    const values = splitSqlList(sql.slice(valuesOpen + 1, valuesClose));
    if (columns.length !== values.length) {
      throw new Error(`Mismatched column/value count for ${resource} demo seed row`);
    }

    const fieldValue = (field: string): string => {
      const index = columns.indexOf(field);
      const value = values[index];
      if (index < 0 || value === undefined) {
        throw new Error(`Missing ${field} field for ${resource} demo seed row`);
      }
      return value;
    };
    const id = parseSqlLiteral(fieldValue("id"));
    const userId = parseSqlLiteral(fieldValue("user_id"));
    if (typeof id !== "string" || typeof userId !== "string") {
      throw new Error(`Missing identity fields for ${resource} demo seed row`);
    }
    transcripts.push({
      resource,
      resourceId: id,
      userId,
      messages: parseJsonArray(fieldValue("messages"), "messages"),
      logs: parseJsonArray(fieldValue("logs"), "logs"),
      toolCalls: parseJsonArray(fieldValue("tool_calls"), "tool_calls"),
    });

    const kept = columns
      .map((column, index) => ({ column, value: values[index] }))
      .filter(({ column }) => !["messages", "logs", "tool_calls"].includes(column));
    let updateClause = sql.slice(valuesClose + 1, statementEnd)
      .split("\n")
      .filter((line) => !/^\s*(messages|logs|tool_calls) = excluded\.\1,\s*$/.test(line))
      .join("\n")
      .replace(/,\s*$/, "");
    output += sql.slice(cursor, statementStart);
    output += `INSERT INTO ${sourceTable} (
  ${kept.map(({ column }) => column).join(",\n  ")}
) VALUES (
  ${kept.map(({ value }) => value).join(",\n  ")}
)${updateClause};`;
    cursor = statementEnd + 1;
    insertPattern.lastIndex = cursor;
  }

  output += sql.slice(cursor);
  const normalized = transcripts.map(transcriptInsertStatements).join("\n\n");
  return output.replace("\nCOMMIT;", `\n${normalized}\n\nCOMMIT;`);
}

function prepareSeedSqlForCurrentSchema(sql: string): string {
  let preparedSql = sql;
  for (const tableName of USER_OWNED_SEED_TABLES) {
    const insertPattern = new RegExp(
      `INSERT INTO ${tableName} \\([\\s\\S]*?\\nON CONFLICT\\(id\\)[\\s\\S]*?;`,
      "g",
    );

    preparedSql = preparedSql.replaceAll(insertPattern, (statement: string) => {
      const columnListEnd = statement.indexOf("\n) VALUES");
      const columnList = columnListEnd === -1 ? statement : statement.slice(0, columnListEnd);
      if (columnList.includes("\n  user_id,")) {
        return statement;
      }

      return statement
        .replace(
          `INSERT INTO ${tableName} (\n  id,`,
          `INSERT INTO ${tableName} (\n  id,\n  user_id,`,
        )
        .replace(/\) VALUES \(\n  ('demo-[^']+',)/, `) VALUES (\n  $1\n  '${DEMO_OWNER_USER_ID}',`);
    });
  }
  return removeLegacyTranscriptFields(preparedSql);
}

function parseArgs(argv: string[]): CliOptions {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  let dataDir = join(repoRoot, "data");
  let applySeed = true;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--skip-apply") {
      applySeed = false;
      continue;
    }

    if (arg === "--data-dir") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("Missing value for --data-dir");
      }
      dataDir = resolve(repoRoot, nextArg);
      index++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dataDir,
    applySeed,
  };
}

async function writeRuntimeArtifacts(dataDir: string): Promise<{
  sqlPath: string;
  keyDir: string;
}> {
  const sqlSourcePath = join(import.meta.dir, "ui-demo-seed.sql");
  const keySourceDir = join(import.meta.dir, "ssh-server-keys");

  const sqlPath = join(dataDir, "ui-demo-seed.sql");
  const keyDir = join(dataDir, "ssh-server-keys");

  await mkdir(dataDir, { recursive: true });
  await mkdir(keyDir, { recursive: true });

  const sql = await Bun.file(sqlSourcePath).text();
  await Bun.write(sqlPath, prepareSeedSqlForCurrentSchema(sql));

  for (const keyFileName of new Bun.Glob("*.json").scanSync({ cwd: keySourceDir })) {
    await Bun.write(
      join(keyDir, keyFileName),
      Bun.file(join(keySourceDir, keyFileName)),
    );
  }

  return {
    sqlPath,
    keyDir,
  };
}

async function loadDatabaseModule(): Promise<DatabaseModule> {
  return await import("../../src/persistence/database");
}

async function applySeedToDatabase(dataDir: string, sqlPath: string): Promise<void> {
  process.env["CLANKY_DATA_DIR"] = dataDir;
  const database = await loadDatabaseModule();
  await database.initializeDatabase();

  try {
    const sql = await Bun.file(sqlPath).text();
    database.getDatabase().exec(sql);
  } finally {
    database.closeDatabase();
  }
}

async function main(): Promise<void> {
  process.env["CLANKY_LOG_LEVEL"] ??= "fatal";

  const options = parseArgs(process.argv.slice(2));
  const { sqlPath, keyDir } = await writeRuntimeArtifacts(options.dataDir);

  if (options.applySeed) {
    await applySeedToDatabase(options.dataDir, sqlPath);
  }

  console.log(`Demo UI artifacts written to ${options.dataDir}`);
  console.log(`SQL seed: ${sqlPath}`);
  console.log(`SSH keys: ${keyDir}`);
  console.log(options.applySeed ? "Database seed applied." : "Database seed skipped.");
}

await main();
