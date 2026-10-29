/**
 * Serializes persisted fixture entities into app-server protocol responses.
 */

import type { PersistedThread, PersistedTurn } from "./codex-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildThread(thread: PersistedThread, includeTurns = false): Record<string, unknown> {
  return {
    id: thread.id,
    environments: null,
    extra: null,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: thread.parentThreadId ?? null,
    preview: thread.parentThreadId ? "Workspace inventory" : "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    model: thread.model,
    reasoningEffort: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    status: thread.status === "idle" ? { type: "idle" } : { type: "active", activeFlags: [] },
    path: null,
    cwd: thread.cwd,
    cliVersion: "0.160.1",
    originator: "codex",
    source: thread.parentThreadId ? { subAgent: { thread_spawn: {
      parent_thread_id: thread.parentThreadId, depth: 1, agent_path: null, agent_nickname: "Workspace inventory", agent_role: "explore",
    } } } : { type: "appServer" },
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: thread.parentThreadId ? "Workspace inventory" : null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: includeTurns ? thread.turns.map(buildTurn) : [],
  };
}

export function buildTurn(turn: PersistedTurn): Record<string, unknown> {
  return {
    id: turn.id,
    items: turn.items,
    itemsView: "full",
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.completedAt === null
      ? null
      : Math.max(0, (turn.completedAt - turn.startedAt) * 1000),
  };
}

export function buildTurnSummary(turn: PersistedTurn): Record<string, unknown> {
  return {
    ...buildTurn(turn),
    // Input was already delivered with turn/start or turn/steer; avoid echoing inline image bytes.
    items: turn.items.filter((item) => !isRecord(item) || item["type"] !== "userMessage"),
    itemsView: "summary",
  };
}
