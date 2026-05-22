/**
 * Hook for managing task-scoped port forwards with live refresh.
 */

import { useCallback, useEffect, useState } from "react";
import type { PortForward, SshSessionEvent } from "../types";
import { isSshSessionEvent, useAppEvents } from "./useAppEvents";
import {
  createTaskPortForwardApi,
  deleteTaskPortForwardApi,
  listTaskPortForwardsApi,
  type CreatePortForwardRequest,
} from "./taskActions";

export interface UseTaskPortForwardsResult {
  forwards: PortForward[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createForward: (request: CreatePortForwardRequest) => Promise<PortForward | null>;
  deleteForward: (forwardId: string) => Promise<boolean>;
}

export function useTaskPortForwards(taskId: string): UseTaskPortForwardsResult {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await listTaskPortForwardsApi(taskId);
      setForwards(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  const createForward = useCallback(async (request: CreatePortForwardRequest): Promise<PortForward | null> => {
    try {
      setError(null);
      const forward = await createTaskPortForwardApi(taskId, request);
      setForwards((prev) => [forward, ...prev.filter((item) => item.config.id !== forward.config.id)]);
      return forward;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [taskId]);

  const deleteForward = useCallback(async (forwardId: string): Promise<boolean> => {
    try {
      setError(null);
      await deleteTaskPortForwardApi(taskId, forwardId);
      setForwards((prev) => prev.filter((item) => item.config.id !== forwardId));
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [taskId]);

  const handleEvent = useCallback((event: SshSessionEvent & { taskId?: string }) => {
    if (!event.type.startsWith("ssh_session.port_forward.")) {
      return;
    }
    if (event.taskId !== taskId) {
      return;
    }
    void refresh();
  }, [taskId, refresh]);

  useAppEvents<SshSessionEvent>(handleEvent, isSshSessionEvent);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    forwards,
    loading,
    error,
    refresh,
    createForward,
    deleteForward,
  };
}
