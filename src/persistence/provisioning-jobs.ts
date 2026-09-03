/**
 * Persistence for user-owned provisioning operations.
 *
 * Jobs are intentionally retained until the user dismisses them. Runtime
 * credentials are never written to this store.
 */

import type { ProvisioningJob, ProvisioningJobError, ProvisioningJobStatus, ProvisioningLogEntry } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "./database";

const log = createLogger("persistence:provisioning-jobs");

export interface PersistedProvisioningJob {
  job: ProvisioningJob;
  logs: ProvisioningLogEntry[];
}

interface ProvisioningJobRow {
  id: string;
  user_id: string;
  config_json: string;
  state_json: string;
  status: string;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProvisioningLogRow {
  id: string;
  source: ProvisioningLogEntry["source"];
  text: string;
  timestamp: string;
  step: ProvisioningLogEntry["step"] | null;
}

const PROVISIONING_STATUSES = new Set<ProvisioningJobStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson<T>(raw: string, label: string, jobId: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    log.warn("Ignoring corrupt provisioning JSON", {
      jobId,
      field: label,
      error: String(error),
    });
    return null;
  }
}

function isProvisioningStatus(value: unknown): value is ProvisioningJobStatus {
  return typeof value === "string" && PROVISIONING_STATUSES.has(value as ProvisioningJobStatus);
}

function parseJobRow(row: ProvisioningJobRow): ProvisioningJob | null {
  const config = parseJson<ProvisioningJob["config"]>(row.config_json, "config", row.id);
  const storedState = parseJson<ProvisioningJob["state"]>(row.state_json, "state", row.id);
  if (!config || !storedState || !isRecord(config) || !isRecord(storedState)) {
    return null;
  }

  if (typeof config["id"] !== "string" || config["id"] !== row.id) {
    log.warn("Ignoring provisioning row with an invalid config id", { jobId: row.id });
    return null;
  }
  if (!isProvisioningStatus(row.status)) {
    log.warn("Ignoring provisioning row with an invalid status", {
      jobId: row.id,
      status: row.status,
    });
    return null;
  }

  // Do not rehydrate server settings from storage. Older or manually edited
  // rows must not turn a persisted snapshot into a credential source.
  const {
    serverSettings: _serverSettings,
    ...safeState
  } = storedState;
  return {
    config: config as ProvisioningJob["config"],
    state: {
      ...safeState,
      status: row.status,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      updatedAt: typeof safeState["updatedAt"] === "string" ? safeState["updatedAt"] : row.updated_at,
    } as ProvisioningJob["state"],
  };
}

function serializeState(state: ProvisioningJob["state"]): string {
  const {
    serverSettings: _serverSettings,
    ...safeState
  } = state;
  return JSON.stringify(safeState);
}

function getLogs(userId: string, jobId: string): ProvisioningLogEntry[] {
  const rows = getDatabase().query(`
    SELECT l.id, l.source, l.text, l.timestamp, l.step
    FROM provisioning_job_logs l
    INNER JOIN provisioning_jobs j ON j.id = l.job_id
    WHERE l.job_id = ? AND j.user_id = ?
    ORDER BY l.timestamp ASC, l.rowid ASC
  `).all(jobId, userId) as ProvisioningLogRow[];

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    text: row.text,
    timestamp: row.timestamp,
    ...(row.step ? { step: row.step } : {}),
  }));
}

function loadJobRow(userId: string, jobId: string): ProvisioningJobRow | null {
  return getDatabase().query(`
    SELECT id, user_id, config_json, state_json, status, workspace_id, created_at, updated_at
    FROM provisioning_jobs
    WHERE id = ? AND user_id = ?
  `).get(jobId, userId) as ProvisioningJobRow | null;
}

export function createProvisioningJob(userId: string, job: ProvisioningJob): void {
  const db = getDatabase();
  db.query(`
    INSERT INTO provisioning_jobs (
      id, user_id, config_json, state_json, status, workspace_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.config.id,
    userId,
    JSON.stringify(job.config),
    serializeState(job.state),
    job.state.status,
    job.state.workspaceId ?? null,
    job.config.createdAt,
    job.state.updatedAt,
  );
}

export function updateProvisioningJob(userId: string, job: ProvisioningJob): void {
  const result = getDatabase().query(`
    UPDATE provisioning_jobs
    SET config_json = ?, state_json = ?, status = ?, workspace_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    JSON.stringify(job.config),
    serializeState(job.state),
    job.state.status,
    job.state.workspaceId ?? null,
    job.state.updatedAt,
    job.config.id,
    userId,
  );
  if (result.changes === 0) {
    log.warn("Provisioning job update affected no rows", {
      jobId: job.config.id,
      userId,
    });
  }
}

export function appendProvisioningJobLog(
  userId: string,
  jobId: string,
  entry: ProvisioningLogEntry,
): void {
  const db = getDatabase();
  db.query(`
    INSERT INTO provisioning_job_logs (id, job_id, source, text, timestamp, step)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM provisioning_jobs WHERE id = ? AND user_id = ?
    )
  `).run(
    entry.id,
    jobId,
    entry.source,
    entry.text,
    entry.timestamp,
    entry.step ?? null,
    jobId,
    userId,
  );
}

export function loadProvisioningJob(userId: string, jobId: string): PersistedProvisioningJob | null {
  const row = loadJobRow(userId, jobId);
  if (!row) {
    return null;
  }
  const job = parseJobRow(row);
  if (!job) {
    return null;
  }
  return {
    job,
    logs: getLogs(userId, jobId),
  };
}

export function listProvisioningJobs(userId: string): ProvisioningJob[] {
  const rows = getDatabase().query(`
    SELECT id, user_id, config_json, state_json, status, workspace_id, created_at, updated_at
    FROM provisioning_jobs
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId) as ProvisioningJobRow[];
  return rows.flatMap((row) => {
    const job = parseJobRow(row);
    return job ? [job] : [];
  });
}

export function dismissProvisioningJob(userId: string, jobId: string): boolean {
  const result = getDatabase().query(
    "DELETE FROM provisioning_jobs WHERE id = ? AND user_id = ?",
  ).run(jobId, userId);
  return result.changes > 0;
}

export function markProvisioningJobsInterrupted(userId: string): number {
  const db = getDatabase();
  const rows = db.query(`
    SELECT id, user_id, config_json, state_json, status, workspace_id, created_at, updated_at
    FROM provisioning_jobs
    WHERE user_id = ? AND status IN ('pending', 'running')
  `).all(userId) as ProvisioningJobRow[];
  let updated = 0;

  for (const row of rows) {
    const job = parseJobRow(row);
    if (!job) {
      continue;
    }
    const now = new Date().toISOString();
    const error: ProvisioningJobError = {
      code: "server_restarted",
      message: "Provisioning was interrupted because the Clanky server restarted.",
      step: job.state.currentStep,
    };
    const nextState: ProvisioningJob["state"] = {
      ...job.state,
      status: "interrupted",
      error,
      completedAt: now,
      updatedAt: now,
    };
    const result = db.query(`
      UPDATE provisioning_jobs
      SET state_json = ?, status = 'interrupted', updated_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run(
      serializeState(nextState),
      now,
      row.id,
      userId,
    );
    if (result.changes > 0) {
      const entry: ProvisioningLogEntry = {
        id: crypto.randomUUID(),
        source: "system",
        text: error.message,
        timestamp: now,
        ...(error.step ? { step: error.step } : {}),
      };
      appendProvisioningJobLog(userId, row.id, entry);
      updated += 1;
    }
  }

  return updated;
}
