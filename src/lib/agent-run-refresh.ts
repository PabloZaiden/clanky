/**
 * Coordinates cancellable, generation-guarded refreshes for agent run lists.
 */

import { isAbortError } from "./request-lifecycle";

export interface AgentRunRefreshOptions {
  force?: boolean;
}

export interface AgentRunRefreshOperation<T> extends AgentRunRefreshOptions {
  load: (signal: AbortSignal) => Promise<T>;
  onLoaded: (value: T) => void;
  onError?: (error: unknown) => void;
}

export interface AgentRunRefreshCoordinator<T> {
  refresh(
    agentId: string,
    operation: AgentRunRefreshOperation<T>,
  ): Promise<void>;
  invalidate(agentId: string): void;
  invalidateAll(): void;
  setMounted(mounted: boolean): void;
}

interface AgentRunRefreshRequest {
  promise: Promise<void>;
  controller: AbortController;
  generation: number;
}

export function createAgentRunRefreshCoordinator<T>(): AgentRunRefreshCoordinator<T> {
  const requests = new Map<string, AgentRunRefreshRequest>();
  const generations = new Map<string, number>();
  let isMounted = true;

  const invalidate = (agentId: string): void => {
    const request = requests.get(agentId);
    if (!request) {
      return;
    }
    request.controller.abort();
    if (requests.get(agentId) === request) {
      requests.delete(agentId);
    }
  };

  const invalidateAll = (): void => {
    for (const request of requests.values()) {
      request.controller.abort();
    }
    requests.clear();
    generations.clear();
  };

  const setMounted = (mounted: boolean): void => {
    isMounted = mounted;
    if (!mounted) {
      invalidateAll();
    }
  };

  const refresh = (
    agentId: string,
    operation: AgentRunRefreshOperation<T>,
  ): Promise<void> => {
    if (!isMounted) {
      return Promise.resolve();
    }

    const existing = requests.get(agentId);
    if (existing && !operation.force) {
      return existing.promise;
    }
    if (existing) {
      invalidate(agentId);
    }

    const controller = new AbortController();
    const generation = (generations.get(agentId) ?? 0) + 1;
    generations.set(agentId, generation);
    const request: AgentRunRefreshRequest = {
      promise: Promise.resolve(),
      controller,
      generation,
    };
    const isCurrentRequest = (): boolean => (
      isMounted
      && !controller.signal.aborted
      && requests.get(agentId) === request
      && generations.get(agentId) === request.generation
    );

    const requestPromise = (async (): Promise<void> => {
      try {
        const value = await operation.load(controller.signal);
        if (isCurrentRequest()) {
          operation.onLoaded(value);
        }
      } catch (error) {
        if (isAbortError(error) || !isCurrentRequest()) {
          return;
        }
        operation.onError?.(error);
      }
    })();
    request.promise = requestPromise.finally(() => {
      if (requests.get(agentId) === request) {
        requests.delete(agentId);
      }
    });
    requests.set(agentId, request);
    return request.promise;
  };

  return {
    refresh,
    invalidate,
    invalidateAll,
    setMounted,
  };
}
