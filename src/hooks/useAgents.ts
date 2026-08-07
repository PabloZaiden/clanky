import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api-error";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { createLogger } from "@pablozaiden/webapp/web";
import type {
  Agent,
  AgentRun,
  Chat,
  DeterministicAgentTestResult,
  DeterministicAgentTestStreamEvent,
  GeneratedAgentCode,
  TaskLogEntry,
} from "@/shared";
import type { CreateAgentRequest, DeleteAgentRunsRequest, GenerateAgentCodeRequest, PrepareGenerateAgentCodeRequest, RunAgentRequest, TestAgentCodeRequest, UpdateAgentRequest } from "@/contracts/schemas";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

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

export interface UseAgentsResult {
  agents: Agent[];
  runsByAgentId: Record<string, AgentRun[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshRuns: (agentId: string) => Promise<void>;
  createAgent: (request: CreateAgentRequest) => Promise<Agent | null>;
  updateAgent: (id: string, request: UpdateAgentRequest) => Promise<Agent | null>;
  prepareGenerateAgentCode: (
    id: string,
    request: PrepareGenerateAgentCodeRequest,
    options?: {
      signal?: AbortSignal;
    },
  ) => Promise<{ chatId: string } | null>;
  generateAgentCode: (
    request: GenerateAgentCodeRequest,
    id?: string,
    options?: {
      signal?: AbortSignal;
      onChatId?: (chatId: string) => void;
    },
  ) => Promise<(GeneratedAgentCode & { chat?: Chat }) | null>;
  testAgentCode: (
    request: TestAgentCodeRequest,
    options?: {
      signal?: AbortSignal;
      onLog?: (entry: TaskLogEntry) => void;
    },
  ) => Promise<DeterministicAgentTestResult | null>;
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

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const data = await apiRequest<Agent[]>("/api/agents", {
        signal: controller.signal,
        action: "Fetch agents",
        fallbackMessage: "Failed to fetch agents",
      });
      if (controller.signal.aborted) {
        return;
      }
      setAgents(sortAgents(data));
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      setError(String(refreshError));
    } finally {
      if (!controller.signal.aborted && showLoading) {
        setLoading(false);
      }
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    try {
      const runs = await apiRequest<AgentRun[]>(`/api/agents/${agentId}/runs`, {
        action: "Fetch agent runs",
        fallbackMessage: "Failed to fetch agent runs",
      });
      setRunsByAgentId((prev) => ({ ...prev, [agentId]: sortRuns(runs) }));
    } catch (refreshError) {
      log.error("Failed to refresh agent runs", { agentId, error: String(refreshError) });
      setError(String(refreshError));
    }
  }, []);

  const refreshAllRuns = useCallback(async () => {
    await Promise.all(Object.keys(runsByAgentId).map((agentId) => refreshRuns(agentId)));
  }, [refreshRuns, runsByAgentId]);

  const requestAgent = useCallback(async <T>(
    path: string,
    options: RequestInit,
    fallback: string,
  ): Promise<T | null> => {
    try {
      return await apiRequest<T>(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
        action: fallback,
        fallbackMessage: fallback,
      });
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        return null;
      }
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

  const prepareGenerateAgentCode = useCallback(async (
    id: string,
    request: PrepareGenerateAgentCodeRequest,
    options: {
      signal?: AbortSignal;
    } = {},
  ): Promise<{ chatId: string } | null> => {
    return requestAgent<{ chatId: string }>(
      `/api/agents/${id}/code/generate/prepare`,
      {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify(request),
      },
      "Failed to prepare the generation conversation",
    );
  }, [requestAgent]);

  const generateAgentCode = useCallback(async (
    request: GenerateAgentCodeRequest,
    id?: string,
    options: {
      signal?: AbortSignal;
      onChatId?: (chatId: string) => void;
    } = {},
  ): Promise<(GeneratedAgentCode & { chat?: Chat }) | null> => {
    try {
      const response = await requestApiResponse(
        id ? `/api/agents/${id}/code/generate` : "/api/agents/code/generate",
        {
          method: "POST",
          signal: options.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          action: "Generate agent code",
          fallbackMessage: "Failed to generate agent code",
        },
      );
      const chatId = response.headers.get("X-Clanky-Generation-Chat-Id");
      if (chatId) {
        options.onChatId?.(chatId);
      }
      const generated = await readApiResponse<GeneratedAgentCode & {
        chat?: Chat;
        error?: string;
        message?: string;
      }>(response);
      if (generated.error) {
        throw new ApiError(generated.message ?? generated.error, {
          code: generated.error,
          status: response.status,
          data: {
            error: generated.error,
            message: generated.message,
          },
        });
      }
      return generated;
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        return null;
      }
      setError(String(requestError));
      return null;
    }
  }, []);

  const testAgentCode = useCallback(async (
    request: TestAgentCodeRequest,
    options: {
      signal?: AbortSignal;
      onLog?: (entry: TaskLogEntry) => void;
    } = {},
  ): Promise<DeterministicAgentTestResult | null> => {
    try {
      const response = await requestApiResponse("/api/agents/code/test/stream", {
        method: "POST",
        signal: options.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Test agent code",
        fallbackMessage: "Failed to test agent code",
      });
      if (!response.body) {
        throw new Error("Deterministic agent test did not return a stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: DeterministicAgentTestResult | null = null;

      const consumeLine = (line: string): void => {
        if (line.trim().length === 0) {
          return;
        }
        const event = JSON.parse(line) as DeterministicAgentTestStreamEvent;
        if (event.type === "log") {
          options.onLog?.(event.log);
        } else if (event.type === "result") {
          result = event.result;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          consumeLine(line);
        }
        if (done) {
          buffer += decoder.decode();
          break;
        }
      }
      consumeLine(buffer);

      if (!result) {
        throw new Error("Deterministic agent test stream ended without a result");
      }
      return result;
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        return null;
      }
      setError(String(requestError));
      return null;
    }
  }, []);

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

  useRealtimeRefreshWithRecovery({
    resources: ["agents"],
    filters: { resource: "agents" },
    refresh: () => refresh({ showLoading: false }),
    onReconnect: () => refresh({ showLoading: false }),
  });

  useRealtimeRefreshWithRecovery({
    resources: ["agent-runs"],
    filters: { resource: "agent-runs" },
    refresh: (event) => event.scope ? refreshRuns(event.scope) : refresh({ showLoading: false }),
    onReconnect: refreshAllRuns,
  });

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
    prepareGenerateAgentCode,
    generateAgentCode,
    testAgentCode,
    deleteAgent,
    runAgent,
    interruptAgent,
    pauseAgent,
    resumeAgent,
    deleteRun,
    purgeRuns,
  };
}
