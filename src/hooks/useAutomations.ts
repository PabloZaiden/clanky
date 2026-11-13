import { useCallback, useState } from "react";
import { ApiError } from "../lib/api-error";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { isAbortError } from "../lib/request-lifecycle";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import type {
  Automation,
  AutomationRun,
  Chat,
  DeterministicAutomationTestResult,
  DeterministicAutomationTestStreamEvent,
  GeneratedAutomationCode,
  ConversationLogEntry,
} from "@/shared";
import type { CreateAutomationRequest, DeleteAutomationRunsRequest, GenerateAutomationCodeRequest, PrepareGenerateAutomationCodeRequest, RunAutomationRequest, TestAutomationCodeRequest, UpdateAutomationRequest } from "@/contracts/schemas";

function sortAutomations(automations: Automation[]): Automation[] {
  return [...automations].sort((left, right) => right.config.updatedAt.localeCompare(left.config.updatedAt));
}

function upsertAutomation(automations: Automation[], automation: Automation): Automation[] {
  return sortAutomations([...automations.filter((item) => item.config.id !== automation.config.id), automation]);
}

function sortRuns(runs: AutomationRun[]): AutomationRun[] {
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function upsertRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  return sortRuns([...runs.filter((item) => item.id !== run.id), run]);
}

interface AutomationCollection {
  automations: Automation[];
  runsByAutomationId: Record<string, AutomationRun[]>;
}

function reconcileAutomation(previous: AutomationCollection | undefined, automation: Automation | null): AutomationCollection | undefined {
  return automation ? {
    automations: upsertAutomation(previous?.automations ?? [], automation),
    runsByAutomationId: previous?.runsByAutomationId ?? {},
  } : previous;
}

function reconcileRun(previous: AutomationCollection | undefined, run: AutomationRun | null): AutomationCollection | undefined {
  return run ? {
    automations: previous?.automations ?? [],
    runsByAutomationId: {
      ...previous?.runsByAutomationId,
      [run.automationId]: upsertRun(previous?.runsByAutomationId[run.automationId] ?? [], run),
    },
  } : previous;
}

function getDownloadFilename(response: Response): string {
  const disposition = response.headers.get("Content-Disposition");
  const filename = disposition?.match(/filename="([^"]+)"/i)?.[1];
  return filename || "clanky-automation.json";
}

export interface UseAutomationsResult {
  automations: Automation[];
  runsByAutomationId: Record<string, AutomationRun[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshRuns: (automationId: string) => Promise<void>;
  createAutomation: (request: CreateAutomationRequest) => Promise<Automation | null>;
  exportAutomation: (id: string) => Promise<void>;
  importAutomation: (workspaceId: string, payload: unknown) => Promise<Automation | null>;
  updateAutomation: (id: string, request: UpdateAutomationRequest) => Promise<Automation | null>;
  prepareGenerateAutomationCode: (
    id: string,
    request: PrepareGenerateAutomationCodeRequest,
    options?: {
      signal?: AbortSignal;
    },
  ) => Promise<{ chatId: string } | null>;
  generateAutomationCode: (
    request: GenerateAutomationCodeRequest,
    id?: string,
    options?: {
      signal?: AbortSignal;
      onChatId?: (chatId: string) => void;
    },
  ) => Promise<(GeneratedAutomationCode & { chat?: Chat }) | null>;
  testAutomationCode: (
    request: TestAutomationCodeRequest,
    options?: {
      signal?: AbortSignal;
      onLog?: (entry: ConversationLogEntry) => void;
    },
  ) => Promise<DeterministicAutomationTestResult | null>;
  deleteAutomation: (id: string) => Promise<boolean>;
  runAutomation: (id: string, request?: RunAutomationRequest) => Promise<AutomationRun | null>;
  interruptAutomation: (id: string) => Promise<AutomationRun | null>;
  pauseAutomation: (id: string) => Promise<Automation | null>;
  resumeAutomation: (id: string) => Promise<Automation | null>;
  deleteRun: (runId: string) => Promise<boolean>;
  purgeRuns: (automationId: string, request?: Partial<DeleteAutomationRunsRequest>) => Promise<string[]>;
}

export function useAutomations(): UseAutomationsResult {
  const [error, setError] = useState<string | null>(null);
  const query = useLiveQuery<AutomationCollection>({
    load: async (signal, previous) => {
      const automations = await apiRequest<Automation[]>("/api/automations", {
        signal,
        action: "Fetch automations",
        fallbackMessage: "Failed to fetch automations",
      });
      const existingIds = new Set(automations.map((automation) => automation.config.id));
      const runs = await Promise.all(Object.keys(previous?.runsByAutomationId ?? {})
        .filter((id) => existingIds.has(id))
        .map(async (automationId) => [automationId, sortRuns(await apiRequest<AutomationRun[]>(`/api/automations/${automationId}/runs`, {
          signal,
          action: "Fetch automation runs",
          fallbackMessage: "Failed to fetch automation runs",
        }))] as const));
      return { automations: sortAutomations(automations), runsByAutomationId: Object.fromEntries(runs) };
    },
    realtime: { resources: ["automations", "automation-runs"] },
  });
  const automations = query.data?.automations ?? [];
  const runsByAutomationId = query.data?.runsByAutomationId ?? {};
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  const refreshRuns = useCallback(async (automationId: string): Promise<void> => {
    try {
      setError(null);
      await mutate(async () => automationId, (previous, id) => previous ? {
        ...previous,
        runsByAutomationId: { ...previous.runsByAutomationId, [id]: previous.runsByAutomationId[id] ?? [] },
      } : { automations: [], runsByAutomationId: { [id]: [] } });
    } catch (error) {
      setError(String(error));
    }
  }, [mutate]);

  const requestAutomation = useCallback(async <T>(
    path: string,
    options: RequestInit,
    fallback: string,
    requestOptions: {
      rethrowErrors?: boolean;
      reconcile?: (previous: AutomationCollection | undefined, result: T) => AutomationCollection | undefined;
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

  const createAutomation = useCallback(async (request: CreateAutomationRequest) => {
    return await requestAutomation<Automation>("/api/automations", {
      method: "POST",
      body: JSON.stringify(request),
    }, "Failed to create automation", { reconcile: reconcileAutomation });
  }, [requestAutomation]);

  const exportAutomation = useCallback(async (id: string): Promise<void> => {
    const response = await requestApiResponse(`/api/automations/${id}/export`, {
      action: "Export automation",
      fallbackMessage: "Failed to export automation",
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

  const importAutomation = useCallback(async (
    workspaceId: string,
    payload: unknown,
  ): Promise<Automation | null> => {
    return await requestAutomation<Automation>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/import`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "Failed to import automation",
      { rethrowErrors: true, reconcile: reconcileAutomation },
    );
  }, [requestAutomation]);

  const updateAutomation = useCallback(async (id: string, request: UpdateAutomationRequest) => {
    return await requestAutomation<Automation>(`/api/automations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }, "Failed to update automation", { reconcile: reconcileAutomation });
  }, [requestAutomation]);

  const prepareGenerateAutomationCode = useCallback(async (
    id: string,
    request: PrepareGenerateAutomationCodeRequest,
    options: {
      signal?: AbortSignal;
    } = {},
  ): Promise<{ chatId: string } | null> => {
    return requestAutomation<{ chatId: string }>(
      `/api/automations/${id}/code/generate/prepare`,
      {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify(request),
      },
      "Failed to prepare the generation conversation",
      { rethrowErrors: true },
    );
  }, [requestAutomation]);

  const generateAutomationCode = useCallback(async (
    request: GenerateAutomationCodeRequest,
    id?: string,
    options: {
      signal?: AbortSignal;
      onChatId?: (chatId: string) => void;
    } = {},
  ): Promise<(GeneratedAutomationCode & { chat?: Chat }) | null> => {
    try {
      setError(null);
      const response = await requestApiResponse(
        id ? `/api/automations/${id}/code/generate` : "/api/automations/code/generate",
        {
          method: "POST",
          signal: options.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          action: "Generate automation code",
          fallbackMessage: "Failed to generate automation code",
        },
      );
      const chatId = response.headers.get("X-Clanky-Generation-Chat-Id");
      if (chatId) {
        options.onChatId?.(chatId);
      }
      const generated = await readApiResponse<GeneratedAutomationCode & {
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

  const testAutomationCode = useCallback(async (
    request: TestAutomationCodeRequest,
    options: {
      signal?: AbortSignal;
      onLog?: (entry: ConversationLogEntry) => void;
    } = {},
  ): Promise<DeterministicAutomationTestResult | null> => {
    try {
      setError(null);
      const response = await requestApiResponse("/api/automations/code/test/stream", {
        method: "POST",
        signal: options.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Test automation code",
        fallbackMessage: "Failed to test automation code",
      });
      if (!response.body) {
        throw new Error("Deterministic automation test did not return a stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: DeterministicAutomationTestResult | null = null;

      const consumeLine = (line: string): void => {
        if (line.trim().length === 0) {
          return;
        }
        const event = JSON.parse(line) as DeterministicAutomationTestStreamEvent;
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
        throw new Error("Deterministic automation test stream ended without a result");
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

  const deleteAutomation = useCallback(async (id: string) => {
    const result = await requestAutomation<{ success: boolean }>(`/api/automations/${id}`, {
      method: "DELETE",
    }, "Failed to delete automation", {
      reconcile: (previous, result) => {
        if (!previous || !result.success) return previous;
        const runsByAutomationId = { ...previous.runsByAutomationId };
        delete runsByAutomationId[id];
        return { automations: previous.automations.filter((automation) => automation.config.id !== id), runsByAutomationId };
      },
    });
    return result?.success ?? false;
  }, [requestAutomation]);

  const runAutomation = useCallback(async (id: string, request: RunAutomationRequest = { attachments: [] }) => {
    return await requestAutomation<AutomationRun>(`/api/automations/${id}/run`, {
      method: "POST",
      body: JSON.stringify(request),
    }, "Failed to run automation", { reconcile: reconcileRun });
  }, [requestAutomation]);

  const interruptAutomation = useCallback(async (id: string) => {
    return await requestAutomation<AutomationRun>(`/api/automations/${id}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to interrupt automation", { reconcile: reconcileRun });
  }, [requestAutomation]);

  const pauseAutomation = useCallback(async (id: string) => {
    return await requestAutomation<Automation>(`/api/automations/${id}/pause`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to pause automation", { reconcile: reconcileAutomation });
  }, [requestAutomation]);

  const resumeAutomation = useCallback(async (id: string) => {
    return await requestAutomation<Automation>(`/api/automations/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    }, "Failed to resume automation", { reconcile: reconcileAutomation });
  }, [requestAutomation]);

  const deleteRun = useCallback(async (runId: string) => {
    const result = await requestAutomation<{ success: boolean }>(`/api/automation-runs/${runId}`, {
      method: "DELETE",
    }, "Failed to delete automation run", {
      reconcile: (previous, result) => previous && result.success ? {
        ...previous,
        runsByAutomationId: Object.fromEntries(Object.entries(previous.runsByAutomationId)
          .map(([automationId, runs]) => [automationId, runs.filter((run) => run.id !== runId)])),
      } : previous,
    });
    return result?.success ?? false;
  }, [requestAutomation]);

  const purgeRuns = useCallback(async (automationId: string, request: Partial<DeleteAutomationRunsRequest> = {}) => {
    const result = await requestAutomation<{ success: boolean; deletedRunIds: string[] }>(`/api/automations/${automationId}/runs`, {
      method: "DELETE",
      body: JSON.stringify(request),
    }, "Failed to purge automation runs", {
      reconcile: (previous, result) => {
        if (!previous) return previous;
        const deleted = new Set(result.deletedRunIds);
        return {
          ...previous,
          runsByAutomationId: {
            ...previous.runsByAutomationId,
            [automationId]: (previous.runsByAutomationId[automationId] ?? []).filter((run) => !deleted.has(run.id)),
          },
        };
      },
    });
    return result?.deletedRunIds ?? [];
  }, [requestAutomation]);

  return {
    automations,
    runsByAutomationId,
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error ? String(query.error) : null),
    refresh,
    refreshRuns,
    createAutomation,
    exportAutomation,
    importAutomation,
    updateAutomation,
    prepareGenerateAutomationCode,
    generateAutomationCode,
    testAutomationCode,
    deleteAutomation,
    runAutomation,
    interruptAutomation,
    pauseAutomation,
    resumeAutomation,
    deleteRun,
    purgeRuns,
  };
}
