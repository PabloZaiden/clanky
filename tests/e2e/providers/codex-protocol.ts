/**
 * Serializes persisted fixture entities into app-server protocol responses.
 */

import type { PersistedThread, PersistedTurn } from "./codex-state";

export function buildThread(thread: PersistedThread, includeTurns = false): Record<string, unknown> {
  return {
    id: thread.id,
    environments: null,
    extra: null,
    sessionId: thread.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
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
    source: { type: "appServer" },
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: includeTurns ? thread.turns : [],
  };
}

export function buildTurn(turn: PersistedTurn): Record<string, unknown> {
  return {
    id: turn.id,
    items: turn.items,
    itemsView: "all",
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.completedAt === null
      ? null
      : Math.max(0, (turn.completedAt - turn.startedAt) * 1000),
  };
}
