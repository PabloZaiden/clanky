import type { AgentRun } from "@/shared/agent";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { rowToAgentRun } from "./helpers";
import { hasLegacyTranscriptColumns, replaceTranscriptEntriesForUser } from "../transcripts/store";

const log = createLogger("persistence:agent-run-transcripts");

export interface LegacyAgentRunTranscriptMigrationResult {
  candidates: number;
  migratedAgentRuns: number;
  remainingAgentRuns: number;
}

export function replaceAgentRunTranscriptEntriesForUser(run: AgentRun, userId: string): void {
  replaceTranscriptEntriesForUser("agent_run", run.id, userId, run);
}

/**
 * Backfill agent-run transcripts before the server accepts requests.
 * Each run is written independently so an interrupted startup can resume.
 */
export function migrateLegacyAgentRunTranscripts(): LegacyAgentRunTranscriptMigrationResult {
  const db = getDatabase();
  if (!hasLegacyTranscriptColumns("agent_run")) {
    return { candidates: 0, migratedAgentRuns: 0, remainingAgentRuns: 0 };
  }
  const candidates = db.prepare(`
    SELECT agent_runs.id, agent_runs.user_id
    FROM agent_runs
    LEFT JOIN agent_run_transcript_meta
      ON agent_run_transcript_meta.agent_run_id = agent_runs.id
      AND agent_run_transcript_meta.user_id = agent_runs.user_id
    WHERE agent_run_transcript_meta.agent_run_id IS NULL
    ORDER BY agent_runs.updated_at ASC, agent_runs.id ASC
  `).all() as Array<{ id: string; user_id: string }>;

  if (candidates.length === 0) {
    return { candidates: 0, migratedAgentRuns: 0, remainingAgentRuns: 0 };
  }

  log.info("Starting legacy agent-run transcript backfill", {
    agentRunCount: candidates.length,
  });

  const loadRunRow = db.prepare("SELECT * FROM agent_runs WHERE id = ? AND user_id = ?");
  const clearLegacyTranscript = db.prepare(`
    UPDATE agent_runs
    SET messages = '[]', logs = '[]', tool_calls = '[]'
    WHERE id = ? AND user_id = ?
  `);
  let migratedAgentRuns = 0;
  for (const candidate of candidates) {
    const row = loadRunRow.get(candidate.id, candidate.user_id) as Record<string, unknown> | null;
    if (!row) {
      throw new Error(`Agent run disappeared during legacy transcript backfill: ${candidate.id}`);
    }

    try {
      replaceAgentRunTranscriptEntriesForUser(rowToAgentRun(row), candidate.user_id);
      clearLegacyTranscript.run(candidate.id, candidate.user_id);
    } catch (error) {
      log.error("Failed to backfill legacy agent-run transcript", {
        agentRunId: candidate.id,
        error: String(error),
      });
      throw new Error(`Failed to migrate legacy agent-run transcript ${candidate.id}`, { cause: error });
    }
    migratedAgentRuns += 1;
  }

  const remainingRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_runs
    LEFT JOIN agent_run_transcript_meta
      ON agent_run_transcript_meta.agent_run_id = agent_runs.id
      AND agent_run_transcript_meta.user_id = agent_runs.user_id
    WHERE agent_run_transcript_meta.agent_run_id IS NULL
  `).get() as { count: number };
  if (remainingRow.count > 0) {
    throw new Error(`Legacy agent-run transcript backfill incomplete: ${remainingRow.count} runs remain`);
  }

  log.info("Completed legacy agent-run transcript backfill", { migratedAgentRuns });
  return {
    candidates: candidates.length,
    migratedAgentRuns,
    remainingAgentRuns: remainingRow.count,
  };
}
