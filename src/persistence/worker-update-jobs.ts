/**
 * Persistence for user-owned Mesh worker update jobs.
 */

import type {
  WorkerUpdateJob,
  WorkerUpdateJobError,
  WorkerUpdateJobStatus,
  WorkerUpdateLogEntry,
} from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  WorkerUpdateJobSchema,
  WorkerUpdateLogEntrySchema,
} from "../contracts/schemas/worker-update";
import { getDatabase } from "./database";

const log = createLogger("persistence:worker-update-jobs");
const MAX_WORKER_UPDATE_LOG_ENTRIES = 500;
const WORKER_UPDATE_STATUSES = new Set<WorkerUpdateJobStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export interface PersistedWorkerUpdateJob {
  job: WorkerUpdateJob;
  logs: WorkerUpdateLogEntry[];
}

interface WorkerUpdateJobRow {
  id: string;
  user_id: string;
  config_json: string;
  state_json: string;
  status: string;
  updated_at: string;
}

interface WorkerUpdateLogRow {
  id: string;
  source: string;
  text: string;
  timestamp: string;
  step: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, field: string, jobId: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    log.warn("Ignoring corrupt worker update JSON", {
      jobId,
      field,
      error: String(error),
    });
    return null;
  }
}

function parseWorkerUpdateJobRow(row: WorkerUpdateJobRow): WorkerUpdateJob | null {
  const config = parseJson(row.config_json, "config", row.id);
  const storedState = parseJson(row.state_json, "state", row.id);
  if (!isRecord(config) || !isRecord(storedState)) {
    return null;
  }
  if (config["id"] !== row.id) {
    log.warn("Ignoring worker update row with an invalid config id", { jobId: row.id });
    return null;
  }
  if (!WORKER_UPDATE_STATUSES.has(row.status as WorkerUpdateJobStatus)) {
    log.warn("Ignoring worker update row with an invalid status", {
      jobId: row.id,
      status: row.status,
    });
    return null;
  }

  const parsed = WorkerUpdateJobSchema.safeParse({
    config,
    state: {
      ...storedState,
      status: row.status,
      updatedAt: typeof storedState["updatedAt"] === "string"
        ? storedState["updatedAt"]
        : row.updated_at,
    },
  });
  if (!parsed.success) {
    log.warn("Ignoring invalid persisted worker update job", {
      jobId: row.id,
      error: parsed.error.message,
    });
    return null;
  }
  return parsed.data;
}

function getJobRow(userId: string, jobId: string): WorkerUpdateJobRow | null {
  return getDatabase().query(`
    SELECT id, user_id, config_json, state_json, status, updated_at
    FROM worker_update_jobs
    WHERE id = ? AND user_id = ?
  `).get(jobId, userId) as WorkerUpdateJobRow | null;
}

function getLogs(userId: string, jobId: string): WorkerUpdateLogEntry[] {
  const rows = getDatabase().query(`
    SELECT logs.id, logs.source, logs.text, logs.timestamp, logs.step
    FROM worker_update_job_logs logs
    INNER JOIN worker_update_jobs jobs ON jobs.id = logs.job_id
    WHERE logs.job_id = ? AND jobs.user_id = ?
    ORDER BY logs.timestamp ASC, logs.rowid ASC
  `).all(jobId, userId) as WorkerUpdateLogRow[];

  return rows.flatMap((row) => {
    const parsed = WorkerUpdateLogEntrySchema.safeParse({
      id: row.id,
      source: row.source,
      text: row.text,
      timestamp: row.timestamp,
      ...(row.step ? { step: row.step } : {}),
    });
    if (!parsed.success) {
      log.warn("Ignoring invalid persisted worker update log", {
        jobId,
        logId: row.id,
        error: parsed.error.message,
      });
      return [];
    }
    return [parsed.data];
  });
}

export function admitWorkerUpdateJob(
  userId: string,
  job: WorkerUpdateJob,
): "admitted" | "already_active" {
  const db = getDatabase();
  const admit = db.transaction(() => {
    const activeJob = db.query(`
      SELECT 1
      FROM worker_update_jobs
      WHERE user_id = ?
        AND json_extract(config_json, '$.workerNodeId') = ?
        AND status IN ('pending', 'running')
      LIMIT 1
    `).get(userId, job.config.workerNodeId);
    if (activeJob !== null) {
      return "already_active";
    }

    db.query(`
      INSERT INTO worker_update_jobs (
        id, user_id, config_json, state_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.config.id,
      userId,
      JSON.stringify(job.config),
      JSON.stringify(job.state),
      job.state.status,
      job.config.createdAt,
      job.state.updatedAt,
    );
    return "admitted";
  });
  return admit.immediate();
}

export function updateWorkerUpdateJob(userId: string, job: WorkerUpdateJob): void {
  const result = getDatabase().query(`
    UPDATE worker_update_jobs
    SET config_json = ?, state_json = ?, status = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    JSON.stringify(job.config),
    JSON.stringify(job.state),
    job.state.status,
    job.state.updatedAt,
    job.config.id,
    userId,
  );
  if (result.changes === 0) {
    throw new Error(`Worker update job "${job.config.id}" was not found for this user.`);
  }
}

export function appendWorkerUpdateJobLog(
  userId: string,
  jobId: string,
  entry: WorkerUpdateLogEntry,
): boolean {
  const db = getDatabase();
  const result = db.query(`
    INSERT INTO worker_update_job_logs (id, job_id, source, text, timestamp, step)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM worker_update_jobs WHERE id = ? AND user_id = ?
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
  if (result.changes === 0) {
    return false;
  }
  db.query(`
    DELETE FROM worker_update_job_logs
    WHERE job_id = ?
      AND id NOT IN (
        SELECT id
        FROM worker_update_job_logs
        WHERE job_id = ?
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?
      )
  `).run(jobId, jobId, MAX_WORKER_UPDATE_LOG_ENTRIES);
  return true;
}

export function loadWorkerUpdateJob(
  userId: string,
  jobId: string,
): PersistedWorkerUpdateJob | null {
  const row = getJobRow(userId, jobId);
  if (!row) {
    return null;
  }
  const job = parseWorkerUpdateJobRow(row);
  if (!job) {
    return null;
  }
  return {
    job,
    logs: getLogs(userId, jobId),
  };
}

export function listWorkerUpdateJobs(userId: string): WorkerUpdateJob[] {
  const rows = getDatabase().query(`
    SELECT id, user_id, config_json, state_json, status, updated_at
    FROM worker_update_jobs
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId) as WorkerUpdateJobRow[];

  return rows.flatMap((row) => {
    const job = parseWorkerUpdateJobRow(row);
    return job ? [job] : [];
  });
}

export function dismissWorkerUpdateJob(userId: string, jobId: string): boolean {
  const result = getDatabase().query(
    "DELETE FROM worker_update_jobs WHERE id = ? AND user_id = ?",
  ).run(jobId, userId);
  return result.changes > 0;
}

export function markWorkerUpdateJobsInterrupted(userId: string): number {
  const db = getDatabase();
  const rows = db.query(`
    SELECT id, user_id, config_json, state_json, status, updated_at
    FROM worker_update_jobs
    WHERE user_id = ? AND status IN ('pending', 'running')
  `).all(userId) as WorkerUpdateJobRow[];
  let updated = 0;

  for (const row of rows) {
    const job = parseWorkerUpdateJobRow(row);
    if (!job) {
      continue;
    }
    const now = new Date().toISOString();
    const error: WorkerUpdateJobError = {
      code: "server_restarted",
      message: "The worker update was interrupted because the Clanky server restarted.",
      ...(job.state.currentStep ? { step: job.state.currentStep } : {}),
    };
    const steps = { ...job.state.steps };
    const currentStep = job.state.currentStep;
    if (currentStep && steps[currentStep].status === "running") {
      steps[currentStep] = {
        ...steps[currentStep],
        status: "unconfirmed",
        completedAt: now,
        error: error.message,
      };
    }
    const interrupted: WorkerUpdateJob = {
      config: job.config,
      state: {
        ...job.state,
        status: "interrupted",
        currentStep: null,
        steps,
        error,
        completedAt: now,
        updatedAt: now,
      },
    };
    const result = db.query(`
      UPDATE worker_update_jobs
      SET state_json = ?, status = 'interrupted', updated_at = ?
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run(
      JSON.stringify(interrupted.state),
      now,
      row.id,
      userId,
    );
    if (result.changes === 0) {
      continue;
    }
    const entry: WorkerUpdateLogEntry = {
      id: crypto.randomUUID(),
      source: "system",
      text: error.message,
      timestamp: now,
      ...(error.step ? { step: error.step } : {}),
    };
    if (!appendWorkerUpdateJobLog(userId, row.id, entry)) {
      log.error("Unable to persist worker update interruption log", {
        jobId: row.id,
        userId,
      });
    }
    updated += 1;
  }
  return updated;
}
