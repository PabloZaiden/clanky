import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getStoredSshCredentialToken,
  storeSshServerPassword,
} from "../lib/ssh-browser-credentials";
import { appFetch } from "../lib/public-path";
import type {
  AgentProvider,
  ProvisioningEvent,
  ProvisioningJobSnapshot,
  ProvisioningLogEntry,
} from "../types";
import { useWebSocket, type WebSocketConnectionStatus } from "./useWebSocket";

export interface StartProvisioningJobRequest {
  name: string;
  sshServerId: string;
  repoUrl: string;
  basePath: string;
  devcontainerSubpath?: string;
  provider: AgentProvider;
  password?: string;
  mode?: "provision" | "rebuild" | "restart" | "arise";
  targetDirectory?: string;
  workspaceId?: string;
}

export interface UseProvisioningJobResult {
  activeJobId: string | null;
  snapshot: ProvisioningJobSnapshot | null;
  logs: ProvisioningLogEntry[];
  loading: boolean;
  starting: boolean;
  error: string | null;
  websocketStatus: WebSocketConnectionStatus;
  startJob: (request: StartProvisioningJobRequest) => Promise<ProvisioningJobSnapshot | null>;
  refreshJob: () => Promise<ProvisioningJobSnapshot | null>;
  cancelJob: () => Promise<boolean>;
  clearActiveJob: () => void;
}

async function resolveProvisioningCredentialToken(
  serverId: string,
  password?: string,
): Promise<string | undefined> {
  const trimmedPassword = password?.trim();
  if (trimmedPassword) {
    await storeSshServerPassword(serverId, trimmedPassword);
  }

  const token = await getStoredSshCredentialToken(serverId);
  return token ?? undefined;
}

function mergeLogEntry(logs: ProvisioningLogEntry[], entry: ProvisioningLogEntry): ProvisioningLogEntry[] {
  if (logs.some((current) => current.id === entry.id)) {
    return logs;
  }
  const nextLogs = [...logs, entry];
  if (nextLogs.length > 2000) {
    return nextLogs.slice(-2000);
  }
  return nextLogs;
}

function isSuccessfulConnectionLog(entry: ProvisioningLogEntry): boolean {
  return entry.source === "system"
    && entry.text.startsWith("Workspace connection test succeeded.");
}

const ACTIVE_JOB_REFRESH_INTERVAL_MS = 1000;

export function useProvisioningJob(): UseProvisioningJobResult {
  const [activeJobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ProvisioningJobSnapshot | null>(null);
  const [logs, setLogs] = useState<ProvisioningLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearActiveJob = useCallback(() => {
    setJobId(null);
    setSnapshot(null);
    setLogs([]);
    setError(null);
  }, []);

  const refreshJob = useCallback(async (): Promise<ProvisioningJobSnapshot | null> => {
    if (!activeJobId) {
      return null;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await appFetch(`/api/provisioning-jobs/${encodeURIComponent(activeJobId)}`);
      if (response.status === 404) {
        clearActiveJob();
        return null;
      }
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message ?? "Failed to load provisioning job");
      }

      const nextSnapshot = await response.json() as ProvisioningJobSnapshot;
      setSnapshot(nextSnapshot);
      setLogs(nextSnapshot.logs);
      return nextSnapshot;
    } catch (nextError) {
      setError(String(nextError));
      return null;
    } finally {
      setLoading(false);
    }
  }, [activeJobId, clearActiveJob]);

  const handleProvisioningEvent = useCallback((event: ProvisioningEvent) => {
    switch (event.type) {
      case "provisioning.output":
        setLogs((current) => mergeLogEntry(current, event.entry));
        if (isSuccessfulConnectionLog(event.entry)) {
          void refreshJob();
        }
        return;
      case "provisioning.started":
      case "provisioning.step":
      case "provisioning.completed":
      case "provisioning.failed":
      case "provisioning.cancelled":
        setSnapshot((current) => current
          ? { ...current, job: event.job }
          : { job: event.job, logs: [] });
        if (
          event.type === "provisioning.completed"
          || event.type === "provisioning.failed"
          || event.type === "provisioning.cancelled"
        ) {
          void refreshJob();
        }
        return;
    }
  }, [refreshJob]);

  const websocketUrl = useMemo(() => {
    return activeJobId
      ? `/api/ws?provisioningJobId=${encodeURIComponent(activeJobId)}`
      : "/api/ws";
  }, [activeJobId]);

  const { status: websocketStatus } = useWebSocket<ProvisioningEvent>({
    url: websocketUrl,
    autoConnect: activeJobId !== null,
    onEvent: handleProvisioningEvent,
    onStatusChange: (status) => {
      if (status === "open" && activeJobId) {
        void refreshJob();
      }
    },
  });

  useEffect(() => {
    if (activeJobId) {
      void refreshJob();
    }
  }, [activeJobId, refreshJob]);

  useEffect(() => {
    const jobStatus = snapshot?.job.state.status;
    if (!activeJobId || (jobStatus && jobStatus !== "pending" && jobStatus !== "running")) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshJob();
    }, ACTIVE_JOB_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeJobId, refreshJob, snapshot?.job.state.status]);

  const startJob = useCallback(async (
    request: StartProvisioningJobRequest,
  ): Promise<ProvisioningJobSnapshot | null> => {
    try {
      setStarting(true);
      setError(null);
      const credentialToken = await resolveProvisioningCredentialToken(
        request.sshServerId,
        request.password,
      );

      const response = await appFetch("/api/provisioning-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: request.name.trim(),
          sshServerId: request.sshServerId,
          repoUrl: request.repoUrl.trim(),
          basePath: request.basePath.trim(),
          ...(request.devcontainerSubpath?.trim()
            ? { devcontainerSubpath: request.devcontainerSubpath.trim() }
            : {}),
          provider: request.provider,
          ...(credentialToken ? { credentialToken } : {}),
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.targetDirectory ? { targetDirectory: request.targetDirectory } : {}),
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        }),
      });
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message ?? "Failed to start provisioning job");
      }

      const nextSnapshot = await response.json() as ProvisioningJobSnapshot;
      setJobId(nextSnapshot.job.config.id);
      setSnapshot(nextSnapshot);
      setLogs(nextSnapshot.logs);
      return nextSnapshot;
    } catch (nextError) {
      setError(String(nextError));
      return null;
    } finally {
      setStarting(false);
    }
  }, []);

  const cancelJob = useCallback(async (): Promise<boolean> => {
    if (!activeJobId) {
      return false;
    }

    try {
      setError(null);
      const response = await appFetch(`/api/provisioning-jobs/${encodeURIComponent(activeJobId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message ?? "Failed to cancel provisioning job");
      }
      await refreshJob();
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    }
  }, [activeJobId, refreshJob]);

  return {
    activeJobId,
    snapshot,
    logs,
    loading,
    starting,
    error,
    websocketStatus,
    startJob,
    refreshJob,
    cancelJob,
    clearActiveJob,
  };
}
