import { useCallback, useState } from "react";
import { ApiError } from "../lib/api-error";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { isAbortError } from "../lib/request-lifecycle";
import { useLiveQuery } from "@pablozaiden/webapp/web";
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

interface AgentCollection {
  agents: Agent[];
  runsByAgentId: Record<string, AgentRun[]>;
}

function reconcileAgent(previous: AgentCollection | undefined, agent: Agent | null): AgentCollection | undefined {
  return agent ? {
    agents: upsertAgent(previous?.agents ?? [], agent),
    runsByAgentId: previous?.runsByAgentId ?? {},
  } : previous;
}

function reconcileRun(previous: AgentCollection | undefined, run: AgentRun | null): AgentCollection | undefined {
  return run ? {
    agents: previous?.agents ?? [],
    runsByAgentId: {
      ...previous?.runsByAgentId,
      [run.agentId]: upsertRun(previous?.runsByAgentId[run.agentId] ?? [], run),
    },
  } : previous;
}

function getDownloadFilename(response: Response): string {
  const disposition = response.headers.get("Content-Disposition");
  const filename = disposition?.match(/filename="([^"]+)"/i)?.[1];
  return filename || "clanky-agent.json";
}

export interface UseAgentsResult {
  agents: Agent[];
  runsByAgentId: Record<string, AgentRun[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshRuns: (agentId: string) => Promise<void>;
  createAgent: (request: CreateAgentRequest) => Promise<Agent | null>;
  exportAgent: (id: string) => Promise<void>;
  importAgent: (workspaceId: string, payload: unknown) => Promise<Agent | null>;
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
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery<AgentCollection>({
    load: async (signal, previous) => {
      const agents = await apiRequest<Agent[]>("/api/agents", {
        signal,
        action: "Fetch agents",
        fallbackMessage: "Failed to fetch agents",
      });
      const existingIds = new Set(agents.map((agent) => agent.config.id));
      const runs = await Promise.all(Object.keys(previous?.runsByAgentId ?? {})
        .filter((id) => existingIds.has(id))
        .map(async (agentId) => [agentId, sortRuns(await apiRequest<AgentRun[]>(`/api/agents/${agentId}/runs`, {
          signal,
          action: "Fetch agent runs",
          fallbackMessage: "Failed to fetch agent runs",
        }))] as const));
      return { agents: sortAgents(agents), runsByAgentId: Object.fromEntries(runs) };
    },
    realtime: { resources: ["agents", "agent-runs"] },
  });
  const agents = query.data?.agents ?? [];
  const runsByAgentId = query.data?.runsByAgentId ?? {};
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  const refreshRuns = useCallback(async (agentId: string): Promise<void> => {
    try {
      setError(null);
      await mutate(async () => agentId, (previous, id) => previous ? {
        ...previous,
        runsByAgentId: { ...previous.runsByAgentId, [id]: previous.runsByAgentId[id] ?? [] },
      } : { agents: [], runsByAgentId: { [id]: [] } });
    } catch (error) {
      setError(String(error));
    }
  }, [mutate]);

  const requestAgent = useCallback(async <T>(
    path: string,
    options: RequestInit,
    fallback: string,
    requestOptions: {
      rethrowErrors?: boolean;
      reconcile?: (previous: AgentCollection | undefined, result: T) => AgentCollection | undefined;
    } = {},
  ): Promise<T | null> => {
    try {
      setError(null);
      const operation = (signal: AbortSignal) => apiRequest<T>(path, {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
        action: fallback,
        fallbackMessage: fallback,
      });
      return await mutate(operation, requestOptions.reconcile);
    } catch (requestError) {
      if (options.signal?.aborted || isAbortError(requestError)) {
        return null;
      }
      setError(String(requestError));
      if (requestOptions.rethrowErrors) {
        throw requestError;
      }
      return null;
    }
  }, [mutate]);

  const createAgent = useCallback(async (request: CreateAgentRequest) => {
    return await requestAgent<Agent>("/api/agents", {
      method: "POST",
      body: JSON.stringify(request),
    }, "Failed to create agent", { reconcile: reconcileAgent });
  }, [requestAgent]);

  const exportAgent = useCallback(async (id: string): Promise<void> => {
    const response = await requestApiResponse(`/api/agents/${id}/export`, {
      action: "Export agent",
      fallbackMessage: "Failed to export agent",
    });
    const blob = await readApiResponse(response, "blob");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = getDownloadFilename(response);
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    try {
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      URL.revokeObjectURL(url);
    }
  }, []);

  const importAgent = useCallback(async (
    workspaceId: string,
    payload: unknown,
  ): Promise<Agent | null> => {
    return await requestAgent<Agent>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/agents/import`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "Failed to import agent",
      { rethrowErrors: true, reconcile: reconcileAgent },
    );
  }, [requestAgent]);

  const updateAgent = useCallback(async (id: string, request: UpdateAgentRequest) => {
    return await requestAgent<Agent>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }, "Failed to update agent", { reconcile: reconcileAgent });
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
      { rethrowErrors: true },
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
      setError(null);
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
      if (isAbortError(requestError)) {
        return null;
      }
      setError(String(requestError));
      throw requestError;
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
      setError(null);
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
    }, "Failed to delete agent", {
      reconcile: (previous, result) => {
        if (!previous || !result.success) return previous;
        const runsByAgentId = { ...previous.runsByAgentId };
        delete runsByAgentId[id];
        return { agents: previous.agents.filter((agent) => agent.config.id !== id), runsByAgentId };
      },
    });
    return result?.success ?? false;
  }, [requestAgent]);

  const runAgent = useCallback(async (id: string, request: RunAgentRequest = { attachments: [] }) => {
    return await requestAgent<AgentRun>(`/api/agents/${id}/run`, {
      method: "POST",
      body: JSON.stringify(request),
    }, "Failed to run agent", { reconcile: reconcileRun });
  }, [requestAgent]);

  const interruptAgent = useCallback(async (id: string) => {
    return await requestAgent<AgentRun>(`/api/agents/${id}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to interrupt agent", { reconcile: reconcileRun });
  }, [requestAgent]);

  const pauseAgent = useCallback(async (id: string) => {
    return await requestAgent<Agent>(`/api/agents/${id}/pause`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to pause agent", { reconcile: reconcileAgent });
  }, [requestAgent]);

  const resumeAgent = useCallback(async (id: string) => {
    return await requestAgent<Agent>(`/api/agents/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to resume agent", { reconcile: reconcileAgent });
  }, [requestAgent]);

  const deleteRun = useCallback(async (runId: string) => {
    const result = await requestAgent<{ success: boolean }>(`/api/agent-runs/${runId}`, {
      method: "DELETE",
    }, "Failed to delete agent run", {
      reconcile: (previous, result) => previous && result.success ? {
        ...previous,
        runsByAgentId: Object.fromEntries(Object.entries(previous.runsByAgentId)
          .map(([agentId, runs]) => [agentId, runs.filter((run) => run.id !== runId)])),
      } : previous,
    });
    return result?.success ?? false;
  }, [requestAgent]);

  const purgeRuns = useCallback(async (agentId: string, request: Partial<DeleteAgentRunsRequest> = {}) => {
    const result = await requestAgent<{ success: boolean; deletedRunIds: string[] }>(`/api/agents/${agentId}/runs`, {
      method: "DELETE",
      body: JSON.stringify(request),
    }, "Failed to purge agent runs", {
      reconcile: (previous, result) => {
        if (!previous) return previous;
        const deleted = new Set(result.deletedRunIds);
        return {
          ...previous,
          runsByAgentId: {
            ...previous.runsByAgentId,
            [agentId]: (previous.runsByAgentId[agentId] ?? []).filter((run) => !deleted.has(run.id)),
          },
        };
      },
    });
    return result?.deletedRunIds ?? [];
  }, [requestAgent]);

  return {
    agents,
    runsByAgentId,
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error ? String(query.error) : null),
    refresh,
    refreshRuns,
    createAgent,
    exportAgent,
    importAgent,
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
