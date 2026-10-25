import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "@pablozaiden/webapp/web";
import type {
  DismissWorkerUpdateJobResponse,
  StartWorkerUpdatesResponse,
  WorkerUpdateJobSnapshotResponse,
  WorkerUpdateJobsResponse,
} from "@/contracts/api";
import { isWorkerUpdateJobTerminal, type WorkerUpdateJob } from "@/shared/worker-update";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { isAbortError } from "../lib/request-lifecycle";

export interface DismissAllWorkerUpdateJobsResult {
  dismissedJobIds: string[];
  failedJobIds: string[];
}

export interface UseWorkerUpdateJobsResult {
  jobs: WorkerUpdateJob[];
  jobsLoading: boolean;
  jobsError: string | null;
  enabled: boolean;
  activeJobId: string | null;
  snapshot: WorkerUpdateJobSnapshotResponse | null;
  loading: boolean;
  notFoundJobId: string | null;
  starting: boolean;
  error: string | null;
  startUpdates: () => Promise<StartWorkerUpdatesResponse | null>;
  openJob: (jobId: string) => void;
  refreshJobs: () => Promise<void>;
  refreshJob: () => Promise<void>;
  dismissJob: (jobId?: string) => Promise<boolean>;
  dismissAllJobs: () => Promise<DismissAllWorkerUpdateJobsResult>;
  dismissingAllJobs: boolean;
  clearActiveJob: () => void;
}

async function dismissWorkerUpdateJobRequest(jobId: string, signal: AbortSignal): Promise<void> {
  await apiRequest<DismissWorkerUpdateJobResponse>(
    `/api/worker-update-jobs/${encodeURIComponent(jobId)}/dismiss`,
    {
      method: "POST",
      signal,
      action: "Dismiss worker update job",
      fallbackMessage: "Failed to dismiss worker update job",
    },
  );
}

export function useWorkerUpdateJobs(
  { enabled = true }: { enabled?: boolean } = {},
): UseWorkerUpdateJobsResult {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [notFoundJobId, setNotFoundJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissingAllJobs, setDismissingAllJobs] = useState(false);
  const dismissAllPromiseRef = useRef<Promise<DismissAllWorkerUpdateJobsResult> | null>(null);
  const activeJobIdRef = useRef(activeJobId);
  activeJobIdRef.current = activeJobId;

  const jobsQuery = useLiveQuery<WorkerUpdateJob[]>({
    enabled,
    load: async (signal) => (await apiRequest<WorkerUpdateJobsResponse>(
      "/api/worker-update-jobs",
      {
        signal,
        action: "Load worker update jobs",
        fallbackMessage: "Failed to load worker update jobs",
      },
    )).jobs,
    realtime: { resources: ["worker-update-jobs"], enabled },
  });
  const jobQuery = useLiveQuery<{ jobId: string; snapshot: WorkerUpdateJobSnapshotResponse | null } | null>({
    enabled: enabled && activeJobId !== null,
    load: async (signal) => {
      if (!activeJobId) throw new Error("Select a worker update job before loading it.");
      const response = await requestApiResponse(
        `/api/worker-update-jobs/${encodeURIComponent(activeJobId)}`,
        {
          signal,
          action: "Load worker update job",
          fallbackMessage: "Failed to load worker update job",
          acceptedStatuses: [404],
        },
      );
      return {
        jobId: activeJobId,
        snapshot: response.status === 404 ? null : await readApiResponse<WorkerUpdateJobSnapshotResponse>(response),
      };
    },
    deps: [enabled, activeJobId],
    realtime: {
      resources: ["worker-update-jobs"],
      ids: activeJobId ? [activeJobId] : [],
      enabled: enabled && activeJobId !== null,
    },
  });
  const mutateJobs = jobsQuery.mutate;
  const mutateJob = jobQuery.mutate;
  const jobs = enabled ? jobsQuery.data ?? [] : [];

  const clearActiveJob = useCallback(() => {
    activeJobIdRef.current = null;
    setActiveJobId(null);
    setError(null);
    setNotFoundJobId(null);
  }, []);

  const openJob = useCallback((jobId: string) => {
    const normalizedId = jobId.trim();
    if (!enabled || !normalizedId || activeJobIdRef.current === normalizedId) return;
    activeJobIdRef.current = normalizedId;
    setActiveJobId(normalizedId);
    setError(null);
    setNotFoundJobId(null);
  }, [enabled]);

  useEffect(() => {
    if (jobQuery.data?.snapshot === null && jobQuery.data.jobId === activeJobIdRef.current) {
      const jobId = jobQuery.data.jobId;
      clearActiveJob();
      setNotFoundJobId(jobId);
    }
  }, [clearActiveJob, jobQuery.data]);

  useEffect(() => {
    if (!enabled) {
      clearActiveJob();
      setStarting(false);
      setDismissingAllJobs(false);
    }
  }, [clearActiveJob, enabled]);

  const startUpdates = useCallback(async (): Promise<StartWorkerUpdatesResponse | null> => {
    if (!enabled) return null;
    setStarting(true);
    setError(null);
    try {
      return await mutateJobs((signal) => apiRequest<StartWorkerUpdatesResponse>("/api/worker-update-jobs", {
        method: "POST",
        signal,
        action: "Start worker updates",
        fallbackMessage: "Failed to start worker updates",
      }));
    } catch (error) {
      if (!isAbortError(error)) setError(String(error));
      return null;
    } finally {
      setStarting(false);
    }
  }, [enabled, mutateJobs]);

  const dismissJob = useCallback(async (jobIdOverride?: string): Promise<boolean> => {
    const jobId = jobIdOverride ?? activeJobIdRef.current;
    if (!enabled || !jobId) return false;
    setError(null);
    try {
      // Both projections establish their barriers before the shared operation.
      await mutateJobs(() => mutateJob(async (signal) => {
        await dismissWorkerUpdateJobRequest(jobId, signal);
      }, (previous) => previous?.jobId === jobId ? null : previous),
      (previous) => previous?.filter((job) => job.config.id !== jobId));
      if (activeJobIdRef.current === jobId) clearActiveJob();
      return true;
    } catch (error) {
      if (!isAbortError(error)) setError(String(error));
      return false;
    }
  }, [clearActiveJob, enabled, mutateJob, mutateJobs]);

  const dismissAllJobs = useCallback((): Promise<DismissAllWorkerUpdateJobsResult> => {
    if (!enabled) return Promise.reject(new Error("Worker update jobs are only available to the owner."));
    if (dismissAllPromiseRef.current) return dismissAllPromiseRef.current;
    const jobIds = jobs.filter((job) => isWorkerUpdateJobTerminal(job.state.status)).map((job) => job.config.id);
    setDismissingAllJobs(true);
    const promise = mutateJobs(() => mutateJob(async (signal) => {
      const results = await Promise.allSettled(jobIds.map((jobId) => dismissWorkerUpdateJobRequest(jobId, signal)));
      signal.throwIfAborted();
      const dismissedJobIds = jobIds.filter((_jobId, index) => results[index]?.status === "fulfilled");
      const failedJobIds = jobIds.filter((_jobId, index) => results[index]?.status === "rejected");
      return { dismissedJobIds, failedJobIds };
    }, (previous, result) => previous && result.dismissedJobIds.includes(previous.jobId) ? null : previous),
    (previous, result) => {
      const dismissed = new Set(result.dismissedJobIds);
      return previous?.filter((job) => !dismissed.has(job.config.id));
    }).then((result) => {
      if (activeJobIdRef.current && result.dismissedJobIds.includes(activeJobIdRef.current)) clearActiveJob();
      return result;
    }).finally(() => {
      dismissAllPromiseRef.current = null;
      setDismissingAllJobs(false);
    });
    dismissAllPromiseRef.current = promise;
    return promise;
  }, [clearActiveJob, enabled, jobs, mutateJob, mutateJobs]);

  return {
    jobs,
    jobsLoading: enabled && jobsQuery.data === undefined && jobsQuery.loading,
    jobsError: enabled && jobsQuery.error ? String(jobsQuery.error) : null,
    enabled,
    activeJobId: enabled ? activeJobId : null,
    snapshot: enabled && jobQuery.data?.jobId === activeJobId ? jobQuery.data.snapshot : null,
    loading: enabled && activeJobId !== null && jobQuery.data === undefined && jobQuery.loading,
    notFoundJobId,
    starting,
    error: error ?? (enabled && jobQuery.error ? String(jobQuery.error) : null),
    startUpdates,
    openJob,
    refreshJobs: jobsQuery.refresh,
    refreshJob: jobQuery.refresh,
    dismissJob,
    dismissAllJobs,
    dismissingAllJobs,
    clearActiveJob,
  };
}
