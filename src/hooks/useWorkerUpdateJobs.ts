import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DismissWorkerUpdateJobResponse,
  StartWorkerUpdatesResponse,
  WorkerUpdateJobSnapshotResponse,
  WorkerUpdateJobsResponse,
} from "@/contracts/api";
import { isWorkerUpdateJobTerminal, type WorkerUpdateJob } from "@/shared/worker-update";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { isAbortError } from "../lib/request-lifecycle";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";

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
  starting: boolean;
  error: string | null;
  startUpdates: () => Promise<StartWorkerUpdatesResponse | null>;
  openJob: (jobId: string) => void;
  refreshJobs: (options?: { showLoading?: boolean; force?: boolean }) => Promise<void>;
  refreshJob: (options?: { showLoading?: boolean }) => Promise<WorkerUpdateJobSnapshotResponse | null>;
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
  const [jobs, setJobs] = useState<WorkerUpdateJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkerUpdateJobSnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissingAllJobs, setDismissingAllJobs] = useState(false);
  const dismissAllPromiseRef = useRef<Promise<DismissAllWorkerUpdateJobsResult> | null>(null);
  const isMountedRef = useRef(false);
  const activeJobIdRef = useRef(activeJobId);
  const actionControllersRef = useRef(new Set<AbortController>());
  const jobsRequestControllerRef = useRef<AbortController | null>(null);
  const jobsRequestIdRef = useRef(0);
  const jobsRefreshCoordinatorRef = useRef(createRefreshCoordinator<void>());
  const jobRequestControllerRef = useRef<AbortController | null>(null);
  const jobRefreshCoordinatorRef = useRef(
    createRefreshCoordinator<WorkerUpdateJobSnapshotResponse | null>(),
  );
  activeJobIdRef.current = activeJobId;

  const refreshJobs = useCallback(async (
    options: { showLoading?: boolean; force?: boolean } = {},
  ): Promise<void> => {
    if (!enabled) {
      return;
    }
    const refresh = async (): Promise<void> => {
      const requestId = ++jobsRequestIdRef.current;
      jobsRequestControllerRef.current?.abort();
      const controller = new AbortController();
      jobsRequestControllerRef.current = controller;
      const showLoading = options.showLoading ?? true;
      if (isMountedRef.current) {
        setJobsLoading(showLoading);
      }
      try {
        const response = await apiRequest<WorkerUpdateJobsResponse>(
          "/api/worker-update-jobs",
          {
            signal: controller.signal,
            action: "Load worker update jobs",
            fallbackMessage: "Failed to load worker update jobs",
          },
        );
        if (
          controller.signal.aborted
          || requestId !== jobsRequestIdRef.current
          || !isMountedRef.current
        ) {
          return;
        }
        setJobs(response.jobs);
        setJobsError(null);
      } catch (refreshError) {
        if (
          controller.signal.aborted
          || requestId !== jobsRequestIdRef.current
          || isAbortError(refreshError)
          || !isMountedRef.current
        ) {
          return;
        }
        setJobsError(String(refreshError));
      } finally {
        if (jobsRequestIdRef.current === requestId) {
          jobsRequestControllerRef.current = null;
          if (!controller.signal.aborted && isMountedRef.current) {
            setJobsLoading(false);
          }
        }
      }
    };

    const refreshPromise = options.force
      ? jobsRefreshCoordinatorRef.current.runAfterCurrent(refresh)
      : jobsRefreshCoordinatorRef.current.run(refresh);
    await refreshPromise;
  }, [enabled]);

  const clearActiveJob = useCallback(() => {
    jobRequestControllerRef.current?.abort();
    jobRequestControllerRef.current = null;
    jobRefreshCoordinatorRef.current.reset();
    activeJobIdRef.current = null;
    setActiveJobId(null);
    setSnapshot(null);
    setLoading(false);
    setError(null);
  }, []);

  const openJob = useCallback((jobId: string) => {
    const normalizedId = jobId.trim();
    if (!enabled || !normalizedId || activeJobIdRef.current === normalizedId) {
      return;
    }
    jobRequestControllerRef.current?.abort();
    jobRequestControllerRef.current = null;
    jobRefreshCoordinatorRef.current.reset();
    activeJobIdRef.current = normalizedId;
    setActiveJobId(normalizedId);
    setSnapshot(null);
    setError(null);
  }, [enabled]);

  const refreshJob = useCallback((
    options: { showLoading?: boolean } = {},
  ): Promise<WorkerUpdateJobSnapshotResponse | null> => {
    if (!enabled) {
      return Promise.resolve(null);
    }
    return jobRefreshCoordinatorRef.current.run(async () => {
      const requestJobId = activeJobIdRef.current;
      if (!requestJobId) {
        return null;
      }
      const showLoading = options.showLoading ?? true;
      const controller = new AbortController();
      jobRequestControllerRef.current = controller;
      try {
        if (showLoading && isMountedRef.current) {
          setLoading(true);
        }
        if (isMountedRef.current) {
          setError(null);
        }
        const response = await requestApiResponse(
          `/api/worker-update-jobs/${encodeURIComponent(requestJobId)}`,
          {
            signal: controller.signal,
            action: "Load worker update job",
            fallbackMessage: "Failed to load worker update job",
            acceptedStatuses: [404],
          },
        );
        if (
          controller.signal.aborted
          || activeJobIdRef.current !== requestJobId
          || !isMountedRef.current
        ) {
          return null;
        }
        if (response.status === 404) {
          clearActiveJob();
          return null;
        }
        const nextSnapshot = await readApiResponse<WorkerUpdateJobSnapshotResponse>(response);
        if (
          controller.signal.aborted
          || activeJobIdRef.current !== requestJobId
          || !isMountedRef.current
        ) {
          return null;
        }
        setSnapshot(nextSnapshot);
        return nextSnapshot;
      } catch (refreshError) {
        if (
          !controller.signal.aborted
          && !isAbortError(refreshError)
          && isMountedRef.current
        ) {
          setError(String(refreshError));
        }
        return null;
      } finally {
        if (jobRequestControllerRef.current === controller) {
          jobRequestControllerRef.current = null;
        }
        if (showLoading && !controller.signal.aborted && isMountedRef.current) {
          setLoading(false);
        }
      }
    });
  }, [clearActiveJob, enabled]);

  useRealtimeRefreshWithRecovery({
    resources: ["worker-update-jobs"],
    ids: activeJobId ? [activeJobId] : [],
    filters: activeJobId
      ? { resource: "worker-update-jobs", id: activeJobId }
      : undefined,
    enabled: enabled && activeJobId !== null,
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
    resources: ["worker-update-jobs"],
    enabled,
    refresh: async () => {
      await refreshJobs({ showLoading: false });
    },
    onReconnect: async () => {
      await refreshJobs({ showLoading: false });
    },
  });

  useEffect(() => {
    isMountedRef.current = true;
    if (enabled) {
      void refreshJobs();
    } else {
      jobsRequestControllerRef.current?.abort();
      jobsRequestControllerRef.current = null;
      jobsRequestIdRef.current += 1;
      setJobs([]);
      setJobsLoading(false);
      setJobsError(null);
      setStarting(false);
      setDismissingAllJobs(false);
      setError(null);
      clearActiveJob();
    }
    return () => {
      isMountedRef.current = false;
      jobsRequestControllerRef.current?.abort();
      jobsRequestControllerRef.current = null;
      jobRequestControllerRef.current?.abort();
      jobRequestControllerRef.current = null;
      for (const controller of actionControllersRef.current) {
        controller.abort();
      }
      actionControllersRef.current.clear();
      jobsRefreshCoordinatorRef.current.reset();
      jobRefreshCoordinatorRef.current.reset();
    };
  }, [clearActiveJob, enabled, refreshJobs]);

  useEffect(() => {
    jobRequestControllerRef.current?.abort();
    jobRequestControllerRef.current = null;
    jobRefreshCoordinatorRef.current.reset();
    if (activeJobId) {
      void refreshJob();
    }
    return () => {
      jobRequestControllerRef.current?.abort();
      jobRequestControllerRef.current = null;
      jobRefreshCoordinatorRef.current.reset();
    };
  }, [activeJobId, refreshJob]);

  const startUpdates = useCallback(async (): Promise<StartWorkerUpdatesResponse | null> => {
    if (!enabled) {
      return null;
    }
    const controller = new AbortController();
    actionControllersRef.current.add(controller);
    try {
      if (isMountedRef.current) {
        setStarting(true);
        setError(null);
      }
      const result = await apiRequest<StartWorkerUpdatesResponse>(
        "/api/worker-update-jobs",
        {
          method: "POST",
          signal: controller.signal,
          action: "Start worker updates",
          fallbackMessage: "Failed to start worker updates",
        },
      );
      if (controller.signal.aborted || !isMountedRef.current) {
        return null;
      }
      await refreshJobs({ showLoading: false, force: true });
      return result;
    } catch (startError) {
      if (!controller.signal.aborted && isMountedRef.current) {
        setError(String(startError));
      }
      return null;
    } finally {
      actionControllersRef.current.delete(controller);
      if (!controller.signal.aborted && isMountedRef.current) {
        setStarting(false);
      }
    }
  }, [enabled, refreshJobs]);

  const dismissJob = useCallback(async (jobIdOverride?: string): Promise<boolean> => {
    if (!enabled) {
      return false;
    }
    const jobId = jobIdOverride ?? activeJobIdRef.current;
    if (!jobId) {
      return false;
    }
    const controller = new AbortController();
    actionControllersRef.current.add(controller);
    try {
      if (isMountedRef.current) {
        setError(null);
      }
      await dismissWorkerUpdateJobRequest(jobId, controller.signal);
      if (controller.signal.aborted || !isMountedRef.current) {
        return false;
      }
      if (activeJobIdRef.current === jobId) {
        clearActiveJob();
      }
      await refreshJobs({ showLoading: false, force: true });
      return true;
    } catch (dismissError) {
      if (!controller.signal.aborted && isMountedRef.current) {
        setError(String(dismissError));
      }
      return false;
    } finally {
      actionControllersRef.current.delete(controller);
    }
  }, [clearActiveJob, enabled, refreshJobs]);

  const dismissAllJobs = useCallback((): Promise<DismissAllWorkerUpdateJobsResult> => {
    if (!enabled) {
      return Promise.reject(new Error("Worker update jobs are only available to the owner."));
    }
    if (dismissAllPromiseRef.current) {
      return dismissAllPromiseRef.current;
    }
    const jobIds = jobs
      .filter((job) => isWorkerUpdateJobTerminal(job.state.status))
      .map((job) => job.config.id);
    const controller = new AbortController();
    actionControllersRef.current.add(controller);
    setDismissingAllJobs(true);
    const dismiss = async (): Promise<DismissAllWorkerUpdateJobsResult> => {
      const results = await Promise.allSettled(
        jobIds.map((jobId) => dismissWorkerUpdateJobRequest(jobId, controller.signal)),
      );
      if (controller.signal.aborted || !isMountedRef.current) {
        throw new DOMException("Worker update dismissal was aborted.", "AbortError");
      }
      const dismissedJobIds: string[] = [];
      const failedJobIds: string[] = [];
      results.forEach((result, index) => {
        const jobId = jobIds[index]!;
        if (result.status === "fulfilled") {
          dismissedJobIds.push(jobId);
        } else {
          failedJobIds.push(jobId);
        }
      });
      if (activeJobIdRef.current && dismissedJobIds.includes(activeJobIdRef.current)) {
        clearActiveJob();
      }
      const dismissedIds = new Set(dismissedJobIds);
      setJobs((current) => current.filter((job) => !dismissedIds.has(job.config.id)));
      await refreshJobs({ showLoading: false, force: true });
      return { dismissedJobIds, failedJobIds };
    };
    const promise = dismiss().finally(() => {
      actionControllersRef.current.delete(controller);
      dismissAllPromiseRef.current = null;
      if (!controller.signal.aborted && isMountedRef.current) {
        setDismissingAllJobs(false);
      }
    });
    dismissAllPromiseRef.current = promise;
    return promise;
  }, [clearActiveJob, enabled, jobs, refreshJobs]);

  return {
    jobs,
    jobsLoading,
    jobsError,
    enabled,
    activeJobId,
    snapshot,
    loading,
    starting,
    error,
    startUpdates,
    openJob,
    refreshJobs,
    refreshJob,
    dismissJob,
    dismissAllJobs,
    dismissingAllJobs,
    clearActiveJob,
  };
}
