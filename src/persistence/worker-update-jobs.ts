/**
 * Persistence for user-owned Mesh worker update jobs.
 */

import type {
  WorkerUpdateJob,
  WorkerUpdateJobError,
  WorkerUpdateJobStatus,
  WorkerUpdateLogEntry,
  WorkerUpdateStepResult,
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
  "connecting",
  "running",
  "verifying",
  "completed",
  "not_started",
  "connection_failed",
  "failed",
  "interrupted",
  "unconfirmed",
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
  const job = parsed.data;
  // Old runners used "interrupted" for lost observations, without execution proof.
  if (job.state.status === "interrupted"
    && (job.state.error?.code === "update_unconfirmed"
      || job.state.error?.code === "restart_unconfirmed"
      || job.state.error?.code === "server_restarted"
      || job.state.steps.update.status === "unconfirmed"
      || job.state.steps.restart.status === "unconfirmed")) {
    return recoverWorkerUpdateJob(job);
  }
  return job;
}

function mayHaveDispatched(step: WorkerUpdateStepResult): boolean {
  if (step.status === "succeeded" || step.status === "failed") return true;
  if (step.execution !== undefined) return step.execution !== "not_started";
  return !["pending", "connecting", "not_started", "connection_failed", "skipped"].includes(step.status);
}

function recoverWorkerUpdateJob(job: WorkerUpdateJob): WorkerUpdateJob {
  const now = new Date().toISOString();
  const steps = { ...job.state.steps };
  const currentStep = job.state.currentStep
    ?? (["running", "connecting", "verifying", "unconfirmed"].includes(steps.restart.status)
      ? "restart"
      : ["running", "connecting", "verifying", "unconfirmed"].includes(steps.update.status)
        ? "update" : undefined);
  const notStarted = !Object.values(steps).some(mayHaveDispatched);
  const unconfirmed = Object.values(steps).some((step) => mayHaveDispatched(step)
    && step.status !== "succeeded" && step.status !== "failed");
  const completed = steps.update.status === "succeeded" && steps.restart.status === "succeeded";
  const status: WorkerUpdateJobStatus = completed
    ? "completed" : notStarted ? "not_started" : unconfirmed ? "unconfirmed" : "failed";
  const error: WorkerUpdateJobError | undefined = completed ? undefined : {
    code: notStarted ? "worker_update_not_started" : unconfirmed ? "worker_update_outcome_unconfirmed" : "worker_update_pipeline_stopped",
    message: notStarted
      ? "The server restarted before command dispatch."
      : unconfirmed
        ? "The server restarted. The command outcome could not be confirmed."
        : "The server restarted before the next step started.",
    ...(currentStep ? { step: currentStep } : {}),
  };
  if (currentStep && error && steps[currentStep].status !== "succeeded"
    && steps[currentStep].status !== "failed") {
    steps[currentStep] = {
      ...steps[currentStep],
      status: mayHaveDispatched(steps[currentStep]) ? "unconfirmed" : "not_started",
      ...(steps[currentStep].execution === undefined ? { startedAt: undefined } : {}),
      completedAt: now,
      error: error.message,
    };
  }
  for (const step of ["update", "restart"] as const) {
    if (steps[step].status === "pending") {
      steps[step] = {
        ...steps[step],
        status: "skipped",
        execution: "not_started",
        completedAt: now,
      };
    }
  }
  return {
    ...job,
    state: {
      ...job.state, status, currentStep: null, steps, error,
      ...(Object.values(steps).some((step) => step.execution === "started"
        || step.execution === "finished" || step.status === "succeeded") ? {} : { startedAt: undefined }),
      completedAt: now, updatedAt: now,
    },
  };
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
        AND status IN ('pending', 'connecting', 'running', 'verifying')
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

export function recoverWorkerUpdateJobs(userId: string): number {
  const db = getDatabase();
  const rows = db.query(`
    SELECT id, user_id, config_json, state_json, status, updated_at
    FROM worker_update_jobs
    WHERE user_id = ? AND status IN ('pending', 'connecting', 'running', 'verifying', 'interrupted')
  `).all(userId) as WorkerUpdateJobRow[];
  let updated = 0;

  for (const row of rows) {
    const job = parseWorkerUpdateJobRow(row);
    if (!job) {
      continue;
    }
    if (row.status === "interrupted" && job.state.status === "interrupted") continue;
    const recovered = row.status === "interrupted" ? job : recoverWorkerUpdateJob(job);
    const now = recovered.state.updatedAt;
    const result = db.query(`
      UPDATE worker_update_jobs
      SET state_json = ?, status = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = ?
    `).run(
      JSON.stringify(recovered.state),
      recovered.state.status,
      now,
      row.id,
      userId,
      row.status,
    );
    if (result.changes === 0) {
      continue;
    }
    const entry: WorkerUpdateLogEntry = {
      id: crypto.randomUUID(),
      source: "system",
      text: recovered.state.error?.message ?? "Worker update completed.",
      timestamp: now,
      ...(recovered.state.error?.step ? { step: recovered.state.error.step } : {}),
    };
    if (!appendWorkerUpdateJobLog(userId, row.id, entry)) {
      log.error("Unable to persist worker update recovery log", {
        jobId: row.id,
        userId,
      });
    }
    updated += 1;
  }
  return updated;
}
