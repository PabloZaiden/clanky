import { useCallback, useEffect, useRef, useState } from "react";
import {
  getStoredSshCredentialToken,
  storeSshServerPassword,
} from "../lib/ssh-browser-credentials";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { isAbortError } from "../lib/request-lifecycle";
import type {
  AgentProvider,
  ProvisioningEvent,
  ProvisioningLogEntry,
  PublicProvisioningJob,
  PublicProvisioningJobSnapshot,
} from "@/shared";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery, useRealtimeStream, type RealtimeStreamStatus } from "./useRealtimeStream";

type ProvisioningStreamEvent = Extract<
  ProvisioningEvent,
  { type: "provisioning.step" | "provisioning.output" }
>;

export interface StartProvisioningJobRequest {
  name: string;
  sshServerId?: string;
  executionNodeId?: string;
  repoUrl: string;
  basePath: string;
  devcontainerSubpath: string | null;
  devboxTemplate: string | null;
  githubUser?: string | null;
  provider: AgentProvider;
  createNewRepository?: boolean;
  password?: string;
  mode: "provision" | "rebuild" | "restart" | "arise";
  targetDirectory: string | null;
  workspaceId: string | null;
}

export interface UseProvisioningJobResult {
  jobs: PublicProvisioningJob[];
  jobsLoading: boolean;
  jobsError: string | null;
  activeJobId: string | null;
  snapshot: PublicProvisioningJobSnapshot | null;
  logs: ProvisioningLogEntry[];
  loading: boolean;
  starting: boolean;
  error: string | null;
  websocketStatus: RealtimeStreamStatus;
  startJob: (request: StartProvisioningJobRequest) => Promise<PublicProvisioningJobSnapshot | null>;
  openJob: (jobId: string) => void;
  refreshJobs: (options?: { showLoading?: boolean }) => Promise<void>;
  refreshJob: (options?: { showLoading?: boolean }) => Promise<PublicProvisioningJobSnapshot | null>;
  cancelJob: () => Promise<boolean>;
  dismissJob: (jobId?: string) => Promise<boolean>;
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
  const [jobs, setJobs] = useState<PublicProvisioningJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [activeJobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PublicProvisioningJobSnapshot | null>(null);
  const [logs, setLogs] = useState<ProvisioningLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeJobIdRef = useRef(activeJobId);
  const jobsRequestControllerRef = useRef<AbortController | null>(null);
  const jobsRequestIdRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<PublicProvisioningJobSnapshot | null>());
  activeJobIdRef.current = activeJobId;

  const refreshJobs = useCallback(async (
    options: { showLoading?: boolean } = {},
  ): Promise<void> => {
    const requestId = ++jobsRequestIdRef.current;
    jobsRequestControllerRef.current?.abort();
    const controller = new AbortController();
    jobsRequestControllerRef.current = controller;
    const showLoading = options.showLoading ?? true;
    if (showLoading) {
      setJobsLoading(true);
    }

    try {
      const response = await apiRequest<{ jobs: PublicProvisioningJob[] }>(
        "/api/provisioning-jobs",
        {
          signal: controller.signal,
          action: "Load provisioning jobs",
          fallbackMessage: "Failed to load provisioning jobs",
        },
      );
      if (
        controller.signal.aborted
        || requestId !== jobsRequestIdRef.current
      ) {
        return;
      }
      setJobs(response.jobs);
      setJobsError(null);
    } catch (nextError) {
      if (
        controller.signal.aborted
        || requestId !== jobsRequestIdRef.current
        || isAbortError(nextError)
      ) {
        return;
      }
      setJobsError(String(nextError));
    } finally {
      if (jobsRequestIdRef.current === requestId) {
        jobsRequestControllerRef.current = null;
        if (showLoading) {
          setJobsLoading(false);
        }
      }
    }
  }, []);

  const clearActiveJob = useCallback(() => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    refreshCoordinatorRef.current.reset();
    activeJobIdRef.current = null;
    setJobId(null);
    setSnapshot(null);
    setLogs([]);
    setError(null);
  }, []);

  const openJob = useCallback((jobId: string) => {
    const trimmedJobId = jobId.trim();
    if (!trimmedJobId) {
      return;
    }
    if (activeJobIdRef.current !== trimmedJobId) {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshCoordinatorRef.current.reset();
      setSnapshot(null);
      setLogs([]);
      setError(null);
    }
    activeJobIdRef.current = trimmedJobId;
    setJobId(trimmedJobId);
  }, []);

  const refreshJob = useCallback((
    options: { showLoading?: boolean } = {},
  ): Promise<PublicProvisioningJobSnapshot | null> => {
    return refreshCoordinatorRef.current.run(async () => {
      const requestJobId = activeJobId;
      if (!requestJobId) {
        return null;
      }

      const showLoading = options.showLoading ?? true;
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      try {
        if (showLoading) {
          setLoading(true);
        }
        setError(null);
        const response = await requestApiResponse(`/api/provisioning-jobs/${encodeURIComponent(requestJobId)}`, {
          signal: controller.signal,
          action: "Load provisioning job",
          fallbackMessage: "Failed to load provisioning job",
          acceptedStatuses: [404],
        });
        if (controller.signal.aborted || activeJobIdRef.current !== requestJobId) {
          return null;
        }
        if (response.status === 404) {
          clearActiveJob();
          return null;
        }
        const nextSnapshot = await readApiResponse<PublicProvisioningJobSnapshot>(response);
        if (controller.signal.aborted || activeJobIdRef.current !== requestJobId) {
          return null;
        }
        setSnapshot(nextSnapshot);
        setLogs(nextSnapshot.logs);
        return nextSnapshot;
      } catch (nextError) {
        if (controller.signal.aborted) {
          return null;
        }
        setError(String(nextError));
        return null;
      } finally {
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = null;
        }
        if (showLoading && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    });
  }, [activeJobId, clearActiveJob]);

  useRealtimeRefreshWithRecovery({
    resources: ["provisioning-jobs"],
    ids: activeJobId ? [activeJobId] : [],
    filters: activeJobId
      ? { resource: "provisioning-jobs", id: activeJobId }
      : undefined,
    enabled: activeJobId !== null,
    refresh: async (event) => {
      if (event.action === "deleted") {
        clearActiveJob();
        return;
      }
      await refreshJob({ showLoading: false });
    },
    onReconnect: async () => {
      await refreshJob({ showLoading: false });
    },
  });

  useRealtimeRefreshWithRecovery({
    resources: ["provisioning-jobs"],
    enabled: true,
    refresh: async () => {
      await refreshJobs({ showLoading: false });
    },
    onReconnect: async () => {
      await refreshJobs({ showLoading: false });
    },
  });

  const handleProvisioningEvent = useCallback((event: ProvisioningStreamEvent) => {
    switch (event.type) {
      case "provisioning.output":
        setLogs((current) => mergeLogEntry(current, event.entry));
        if (isSuccessfulConnectionLog(event.entry)) {
          void refreshJob();
        }
        return;
      case "provisioning.step":
        setSnapshot((current) => current
          ? { ...current, job: event.job }
          : { job: event.job, logs: [] });
        return;
    }
  }, [refreshJob]);

  const { status: websocketStatus } = useRealtimeStream<ProvisioningStreamEvent>({
    enabled: activeJobId !== null,
    filters: activeJobId ? { provisioningJobId: activeJobId } : undefined,
    predicate: (event) => event.type.startsWith("provisioning."),
    onEvent: handleProvisioningEvent,
  });

  useEffect(() => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    refreshCoordinatorRef.current.reset();
    if (activeJobId) {
      void refreshJob();
    }
    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshCoordinatorRef.current.reset();
    };
  }, [activeJobId, refreshJob]);

  useEffect(() => {
    const jobStatus = snapshot?.job.state.status;
    if (!activeJobId || (jobStatus && jobStatus !== "pending" && jobStatus !== "running")) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshJob({ showLoading: false });
    }, ACTIVE_JOB_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeJobId, refreshJob, snapshot?.job.state.status]);

  const startJob = useCallback(async (
    request: StartProvisioningJobRequest,
  ): Promise<PublicProvisioningJobSnapshot | null> => {
    try {
      setStarting(true);
      setError(null);
      const credentialToken = request.sshServerId
        ? await resolveProvisioningCredentialToken(request.sshServerId, request.password)
        : undefined;

      const nextSnapshot = await apiRequest<PublicProvisioningJobSnapshot>("/api/provisioning-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: request.name.trim(),
          sshServerId: request.sshServerId ?? null,
          executionNodeId: request.executionNodeId ?? null,
          repoUrl: request.repoUrl.trim(),
          basePath: request.basePath.trim(),
          devcontainerSubpath: request.devcontainerSubpath?.trim() ? request.devcontainerSubpath.trim() : null,
          devboxTemplate: request.devboxTemplate?.trim() ? request.devboxTemplate.trim() : null,
          githubUser: request.githubUser?.trim() ? request.githubUser.trim() : null,
          provider: request.provider,
          credentialToken: credentialToken ?? null,
          mode: request.mode,
          createNewRepository: request.createNewRepository ?? false,
          targetDirectory: request.targetDirectory?.trim() ? request.targetDirectory.trim() : null,
          workspaceId: request.workspaceId?.trim() ? request.workspaceId.trim() : null,
        }),
        action: "Start provisioning job",
        fallbackMessage: "Failed to start provisioning job",
      });
      setJobId(nextSnapshot.job.config.id);
      activeJobIdRef.current = nextSnapshot.job.config.id;
      setSnapshot(nextSnapshot);
      setLogs(nextSnapshot.logs);
      await refreshJobs({ showLoading: false });
      return nextSnapshot;
    } catch (nextError) {
      setError(String(nextError));
      return null;
    } finally {
      setStarting(false);
    }
  }, [refreshJobs]);

  const cancelJob = useCallback(async (): Promise<boolean> => {
    if (!activeJobId) {
      return false;
    }

    try {
      setError(null);
      await apiRequest(`/api/provisioning-jobs/${encodeURIComponent(activeJobId)}`, {
        method: "DELETE",
        action: "Cancel provisioning job",
        fallbackMessage: "Failed to cancel provisioning job",
      });
      await refreshJob();
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    }
  }, [activeJobId, refreshJob]);

  const dismissJob = useCallback(async (jobIdOverride?: string): Promise<boolean> => {
    const jobId = jobIdOverride ?? activeJobIdRef.current;
    if (!jobId) {
      return false;
    }

    try {
      setError(null);
      await apiRequest(`/api/provisioning-jobs/${encodeURIComponent(jobId)}/dismiss`, {
        method: "POST",
        action: "Dismiss provisioning job",
        fallbackMessage: "Failed to dismiss provisioning job",
      });
      if (activeJobIdRef.current === jobId) {
        clearActiveJob();
      }
      await refreshJobs({ showLoading: false });
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    }
  }, [clearActiveJob, refreshJobs]);

  useEffect(() => {
    void refreshJobs();
    return () => {
      jobsRequestControllerRef.current?.abort();
      jobsRequestControllerRef.current = null;
    };
  }, [refreshJobs]);

  return {
    jobs,
    jobsLoading,
    jobsError,
    activeJobId,
    snapshot,
    logs,
    loading,
    starting,
    error,
    websocketStatus,
    startJob,
    openJob,
    refreshJobs,
    refreshJob,
    cancelJob,
    dismissJob,
    clearActiveJob,
  };
}
