import { useCallback, useEffect, useRef, useState } from "react";
import { appFetch } from "../lib/public-path";
import { createLogger } from "../lib/logger";
import type {
  Agent,
  AgentEvent,
  AgentRun,
  AgentRunStatus,
} from "../types";
import type {
  CreateAgentRequest,
  DeleteAgentRunsRequest,
  RunAgentRequest,
  UpdateAgentRequest,
} from "../types/schemas";
import { isAgentEvent, useAppEvents } from "./useAppEvents";

const log = createLogger("useAgents");

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => right.config.updatedAt.localeCompare(left.config.updatedAt));
}

function upsertAgent(agents: Agent[], agent: Agent): Agent[] {
  return sortAgents([...agents.filter((item) => item.config.id !== agent.config.id), agent]);
}

function sortRuns(runs: AgentRun[]): AgentRun[] {
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function upsertRun(runs: AgentRun[], run: AgentRun): AgentRun[] {
  return sortRuns([...runs.filter((item) => item.id !== run.id), run]);
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "skipped"
    || status === "cancelled"
    || status === "interrupted";
}

function updateKnownRunStatus(
  runs: AgentRun[],
  runId: string,
  status: AgentRunStatus,
  timestamp: string,
  options: {
    errorMessage?: string;
    skipReason?: string;
  } = {},
): AgentRun[] {
  let changed = false;
  const nextRuns = runs.map((run) => {
    if (run.id !== runId) {
      return run;
    }
    changed = true;
    return {
      ...run,
      status,
      completedAt: isTerminalRunStatus(status) ? run.completedAt ?? timestamp : run.completedAt,
      skipReason: options.skipReason ?? run.skipReason,
      error: options.errorMessage
        ? {
            message: options.errorMessage,
            timestamp,
            code: status,
          }
        : run.error,
      updatedAt: timestamp,
    };
  });
  return changed ? sortRuns(nextRuns) : runs;
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export interface UseAgentsResult {
  agents: Agent[];
  runsByAgentId: Record<string, AgentRun[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshRuns: (agentId: string) => Promise<void>;
  createAgent: (request: CreateAgentRequest) => Promise<Agent | null>;
  updateAgent: (id: string, request: UpdateAgentRequest) => Promise<Agent | null>;
  deleteAgent: (id: string) => Promise<boolean>;
  runAgent: (id: string, request?: RunAgentRequest) => Promise<AgentRun | null>;
  interruptAgent: (id: string) => Promise<AgentRun | null>;
  pauseAgent: (id: string) => Promise<Agent | null>;
  resumeAgent: (id: string) => Promise<Agent | null>;
  deleteRun: (runId: string) => Promise<boolean>;
  purgeRuns: (agentId: string, request?: Partial<DeleteAgentRunsRequest>) => Promise<string[]>;
}

export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runsByAgentId, setRunsByAgentId] = useState<Record<string, AgentRun[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/agents", { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to fetch agents"));
      }
      const data = await response.json() as Agent[];
      setAgents(sortAgents(data));
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      setError(String(refreshError));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    try {
      const response = await appFetch(`/api/agents/${agentId}/runs`);
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to fetch agent runs"));
      }
      const runs = await response.json() as AgentRun[];
      setRunsByAgentId((prev) => ({ ...prev, [agentId]: sortRuns(runs) }));
    } catch (refreshError) {
      log.error("Failed to refresh agent runs", { agentId, error: String(refreshError) });
      setError(String(refreshError));
    }
  }, []);

  const requestAgent = useCallback(async <T>(
    path: string,
    options: RequestInit,
    fallback: string,
  ): Promise<T | null> => {
    try {
      const response = await appFetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      });
      if (!response.ok) {
        throw new Error(await parseError(response, fallback));
      }
      return await response.json() as T;
    } catch (requestError) {
      setError(String(requestError));
      return null;
    }
  }, []);

  const createAgent = useCallback(async (request: CreateAgentRequest) => {
    const agent = await requestAgent<Agent>("/api/agents", {
      method: "POST",
      body: JSON.stringify(request),
    }, "Failed to create agent");
    if (agent) {
      setAgents((prev) => upsertAgent(prev, agent));
    }
    return agent;
  }, [requestAgent]);

  const updateAgent = useCallback(async (id: string, request: UpdateAgentRequest) => {
    const agent = await requestAgent<Agent>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }, "Failed to update agent");
    if (agent) {
      setAgents((prev) => upsertAgent(prev, agent));
    }
    return agent;
  }, [requestAgent]);

  const deleteAgent = useCallback(async (id: string) => {
    const result = await requestAgent<{ success: boolean }>(`/api/agents/${id}`, {
      method: "DELETE",
    }, "Failed to delete agent");
    if (result?.success) {
      setAgents((prev) => prev.filter((agent) => agent.config.id !== id));
      setRunsByAgentId((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return true;
    }
    return false;
  }, [requestAgent]);

  const runAgent = useCallback(async (id: string, request: RunAgentRequest = { attachments: [] }) => {
    const run = await requestAgent<AgentRun>(`/api/agents/${id}/run`, {
      method: "POST",
      body: JSON.stringify(request),
    }, "Failed to run agent");
    if (run) {
      setRunsByAgentId((prev) => ({ ...prev, [run.agentId]: upsertRun(prev[run.agentId] ?? [], run) }));
    }
    return run;
  }, [requestAgent]);

  const interruptAgent = useCallback(async (id: string) => {
    const run = await requestAgent<AgentRun>(`/api/agents/${id}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to interrupt agent");
    if (run) {
      setRunsByAgentId((prev) => ({ ...prev, [run.agentId]: upsertRun(prev[run.agentId] ?? [], run) }));
    }
    return run;
  }, [requestAgent]);

  const pauseAgent = useCallback(async (id: string) => {
    const agent = await requestAgent<Agent>(`/api/agents/${id}/pause`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to pause agent");
    if (agent) {
      setAgents((prev) => upsertAgent(prev, agent));
    }
    return agent;
  }, [requestAgent]);

  const resumeAgent = useCallback(async (id: string) => {
    const agent = await requestAgent<Agent>(`/api/agents/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to resume agent");
    if (agent) {
      setAgents((prev) => upsertAgent(prev, agent));
    }
    return agent;
  }, [requestAgent]);

  const deleteRun = useCallback(async (runId: string) => {
    const result = await requestAgent<{ success: boolean }>(`/api/agent-runs/${runId}`, {
      method: "DELETE",
    }, "Failed to delete agent run");
    if (result?.success) {
      setRunsByAgentId((prev) => Object.fromEntries(
        Object.entries(prev).map(([agentId, runs]) => [agentId, runs.filter((run) => run.id !== runId)]),
      ));
      return true;
    }
    return false;
  }, [requestAgent]);

  const purgeRuns = useCallback(async (agentId: string, request: Partial<DeleteAgentRunsRequest> = {}) => {
    const result = await requestAgent<{ success: boolean; deletedRunIds: string[] }>(`/api/agents/${agentId}/runs`, {
      method: "DELETE",
      body: JSON.stringify(request),
    }, "Failed to purge agent runs");
    const deletedRunIds = result?.deletedRunIds ?? [];
    if (deletedRunIds.length > 0) {
      const deleted = new Set(deletedRunIds);
      setRunsByAgentId((prev) => ({
        ...prev,
        [agentId]: (prev[agentId] ?? []).filter((run) => !deleted.has(run.id)),
      }));
    }
    return deletedRunIds;
  }, [requestAgent]);

  useAppEvents<AgentEvent>((event) => {
    if (event.type === "agent.created" || event.type === "agent.updated") {
      setAgents((prev) => upsertAgent(prev, event.agent));
      return;
    }
    if (event.type === "agent.deleted") {
      setAgents((prev) => prev.filter((agent) => agent.config.id !== event.agentId));
      return;
    }
    if (
      event.type === "agent.run.scheduled"
      || event.type === "agent.run.started"
      || event.type === "agent.run.completed"
    ) {
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: upsertRun(prev[event.agentId] ?? [], event.run),
      }));
      void refresh();
      return;
    }
    if (event.type === "agent.run.status") {
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: updateKnownRunStatus(
          prev[event.agentId] ?? [],
          event.agentRunId,
          event.status,
          event.timestamp,
        ),
      }));
      if (isTerminalRunStatus(event.status)) {
        void refreshRuns(event.agentId);
        void refresh();
      }
      return;
    }
    if (event.type === "agent.run.failed") {
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: updateKnownRunStatus(
          prev[event.agentId] ?? [],
          event.agentRunId,
          "failed",
          event.timestamp,
          { errorMessage: event.message },
        ),
      }));
      void refreshRuns(event.agentId);
      void refresh();
      return;
    }
    if (event.type === "agent.run.skipped") {
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: updateKnownRunStatus(
          prev[event.agentId] ?? [],
          event.agentRunId,
          "skipped",
          event.timestamp,
          { skipReason: event.reason },
        ),
      }));
      void refreshRuns(event.agentId);
      void refresh();
      return;
    }
    if (event.type === "agent.run.interrupted") {
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: updateKnownRunStatus(
          prev[event.agentId] ?? [],
          event.agentRunId,
          "interrupted",
          event.timestamp,
        ),
      }));
      void refreshRuns(event.agentId);
      void refresh();
      return;
    }
    if (event.type === "agent.run.deleted") {
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: (prev[event.agentId] ?? []).filter((run) => run.id !== event.agentRunId),
      }));
      return;
    }
    if (event.type === "agent.runs.purged") {
      const deleted = new Set(event.deletedRunIds);
      setRunsByAgentId((prev) => ({
        ...prev,
        [event.agentId]: (prev[event.agentId] ?? []).filter((run) => !deleted.has(run.id)),
      }));
    }
  }, isAgentEvent);

  useEffect(() => {
    void refresh();
    return () => abortControllerRef.current?.abort();
  }, [refresh]);

  return {
    agents,
    runsByAgentId,
    loading,
    error,
    refresh,
    refreshRuns,
    createAgent,
    updateAgent,
    deleteAgent,
    runAgent,
    interruptAgent,
    pauseAgent,
    resumeAgent,
    deleteRun,
    purgeRuns,
  };
}
