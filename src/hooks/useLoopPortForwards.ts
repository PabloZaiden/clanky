/**
 * Hook for managing loop-scoped port forwards with live refresh.
 */

import { useCallback, useEffect, useState } from "react";
import type { PortForward, SshSessionEvent } from "../types";
import { useAppEvents } from "./useAppEvents";
import {
  createLoopPortForwardApi,
  deleteLoopPortForwardApi,
  listLoopPortForwardsApi,
  type CreatePortForwardRequest,
} from "./loopActions";

export interface UseLoopPortForwardsResult {
  forwards: PortForward[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createForward: (request: CreatePortForwardRequest) => Promise<PortForward | null>;
  deleteForward: (forwardId: string) => Promise<boolean>;
}

export function useLoopPortForwards(loopId: string): UseLoopPortForwardsResult {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await listLoopPortForwardsApi(loopId);
      setForwards(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [loopId]);

  const createForward = useCallback(async (request: CreatePortForwardRequest): Promise<PortForward | null> => {
    try {
      setError(null);
      const forward = await createLoopPortForwardApi(loopId, request);
      setForwards((prev) => [forward, ...prev.filter((item) => item.config.id !== forward.config.id)]);
      return forward;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [loopId]);

  const deleteForward = useCallback(async (forwardId: string): Promise<boolean> => {
    try {
      setError(null);
      await deleteLoopPortForwardApi(loopId, forwardId);
      setForwards((prev) => prev.filter((item) => item.config.id !== forwardId));
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [loopId]);

  const handleEvent = useCallback((event: SshSessionEvent & { loopId?: string }) => {
    if (!event.type.startsWith("ssh_session.port_forward.")) {
      return;
    }
    if (event.loopId !== loopId) {
      return;
    }
    void refresh();
  }, [loopId, refresh]);

  useAppEvents<SshSessionEvent>(handleEvent);

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
