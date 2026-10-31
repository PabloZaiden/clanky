import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../lib/api-client";
import { isApiErrorCode } from "../lib/api-error";
import { isProvisioningJobTerminal } from "@/shared";
import type {
  AgentProvider,
  HarnessAdapter,
  ProvisioningLogEntry,
  PublicProvisioningJob,
  PublicProvisioningJobSnapshot,
  ExecutionHostRef,
  ProvisioningWorkerEnrollmentRoute,
} from "@/shared";
import { useLiveQuery, type RealtimeStatus } from "@pablozaiden/webapp/web";
import { useProvisioningSnapshot } from "./useProvisioningSnapshot";
import type { WorkerUpdateMode } from "@/shared/worker-update";

export interface StartProvisioningJobRequest {
  name: string;
  executionHost?: ExecutionHostRef;
  workspaceWorkerEnrollmentId?: string;
  workerEnrollmentRoute?: ProvisioningWorkerEnrollmentRoute;
  workerRelayName?: string;
  workerHostAddress?: string;
  workerHostAddressManual?: boolean;
  repoUrl: string;
  basePath: string;
  devcontainerSubpath: string | null;
  devboxTemplate: string | null;
  githubUser?: string | null;
  provider: AgentProvider;
  adapter?: HarnessAdapter;
  createNewRepository?: boolean;
  mode: "provision" | "rebuild" | "restart" | "arise";
  targetDirectory: string | null;
  workspaceId: string | null;
  channel?: WorkerUpdateMode;
}

export interface DismissAllProvisioningJobsResult {
  dismissedJobIds: string[];
  failedJobIds: string[];
}

export interface UseProvisioningJobResult {
  jobs: PublicProvisioningJob[];
  jobsLoading: boolean;
  jobsError: string | null;
  activeJobId: string | null;
  snapshot: PublicProvisioningJobSnapshot | null;
  logs: ProvisioningLogEntry[];
  loading: boolean;
  notFoundJobId: string | null;
  starting: boolean;
  error: string | null;
  websocketStatus: RealtimeStatus;
  startJob: (request: StartProvisioningJobRequest) => Promise<PublicProvisioningJobSnapshot | null>;
  openJob: (jobId: string) => void;
  refreshJobs: () => Promise<void>;
  refreshJob: () => Promise<void>;
  cancelJob: () => Promise<boolean>;
  dismissJob: (jobId?: string) => Promise<boolean>;
  dismissAllJobs: () => Promise<DismissAllProvisioningJobsResult>;
  dismissingAllJobs: boolean;
  clearActiveJob: () => void;
}

const DISMISS_RETRY_DELAY_MS = 100;
const MAX_DISMISS_RETRIES = 50;

function isDismissibleProvisioningJob(job: PublicProvisioningJob): boolean {
  return isProvisioningJobTerminal(job.state.status);
}

function waitForDismissRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Dismissal retry was aborted", "AbortError"));
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const handleAbort = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", handleAbort);
      reject(new DOMException("Dismissal retry was aborted", "AbortError"));
    };

    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, DISMISS_RETRY_DELAY_MS);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function dismissProvisioningJobRequest(
  jobId: string,
  options: {
    signal?: AbortSignal;
    retryOnReadiness?: boolean;
  } = {},
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    try {
      await apiRequest(`/api/provisioning-jobs/${encodeURIComponent(jobId)}/dismiss`, {
        method: "POST",
        signal: options.signal,
        action: "Dismiss provisioning job",
        fallbackMessage: "Failed to dismiss provisioning job",
      });
      return;
    } catch (error) {
      if (
        !options.retryOnReadiness
        || !isApiErrorCode(error, "job_not_terminal")
        || retry >= MAX_DISMISS_RETRIES
      ) {
        throw error;
      }
      await waitForDismissRetry(options.signal);
    }
  }
}

export function useProvisioningJob({ enabled = true }: { enabled?: boolean } = {}): UseProvisioningJobResult {
  const jobsQuery = useLiveQuery<PublicProvisioningJob[]>({
    enabled,
    load: async (signal) => (await apiRequest<{ jobs: PublicProvisioningJob[] }>("/api/provisioning-jobs", {
      signal,
      action: "Load provisioning jobs",
      fallbackMessage: "Failed to load provisioning jobs",
    })).jobs,
    realtime: { resources: ["provisioning-jobs"] },
  });
  const jobs = jobsQuery.data ?? [];
  const { refresh: refreshJobs, mutate } = jobsQuery;
  const [activeJobId, setJobId] = useState<string | null>(null);
  const [initialSnapshot, setInitialSnapshot] = useState<PublicProvisioningJobSnapshot | null>(null);
  const [notFoundJobId, setNotFoundJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissingAllJobs, setDismissingAllJobs] = useState(false);
  const dismissingAllJobsRef = useRef(false);
  const dismissingAllControllerRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef(activeJobId);
  activeJobIdRef.current = activeJobId;

  const clearActiveJob = useCallback(() => {
    activeJobIdRef.current = null;
    setJobId(null);
    setInitialSnapshot(null);
    setError(null);
    setNotFoundJobId(null);
  }, []);

  const openJob = useCallback((jobId: string) => {
    const trimmedJobId = jobId.trim();
    if (!trimmedJobId) {
      return;
    }
    if (activeJobIdRef.current !== trimmedJobId) {
      setInitialSnapshot(null);
      setError(null);
      setNotFoundJobId(null);
    }
    activeJobIdRef.current = trimmedJobId;
    setJobId(trimmedJobId);
  }, []);

  const { snapshot, loading, notFound, refreshJob, websocketStatus, error: snapshotError } =
    useProvisioningSnapshot(activeJobId, initialSnapshot);
  useEffect(() => {
    if (!notFound || !activeJobId) return;
    clearActiveJob();
    setNotFoundJobId(activeJobId);
  }, [activeJobId, clearActiveJob, notFound]);

  const startJob = useCallback(async (
    request: StartProvisioningJobRequest,
  ): Promise<PublicProvisioningJobSnapshot | null> => {
    try {
      setStarting(true);
      setError(null);
      const nextSnapshot = await mutate((signal) => apiRequest<PublicProvisioningJobSnapshot>("/api/provisioning-jobs", {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: request.name.trim(),
          ...(request.executionHost ? { executionHost: request.executionHost } : {}),
          ...(request.workspaceWorkerEnrollmentId
            ? { workspaceWorkerEnrollmentId: request.workspaceWorkerEnrollmentId }
            : {}),
          ...(request.workerEnrollmentRoute
            ? { workerEnrollmentRoute: request.workerEnrollmentRoute }
            : {}),
          ...(request.workerRelayName
            ? { workerRelayName: request.workerRelayName }
            : {}),
          ...(request.workerHostAddress
            ? { workerHostAddress: request.workerHostAddress.trim() }
            : {}),
          ...(request.workerHostAddressManual
            ? { workerHostAddressManual: true }
            : {}),
          repoUrl: request.repoUrl.trim(),
          basePath: request.basePath.trim(),
          devcontainerSubpath: request.devcontainerSubpath?.trim() ? request.devcontainerSubpath.trim() : null,
          devboxTemplate: request.devboxTemplate?.trim() ? request.devboxTemplate.trim() : null,
          githubUser: request.githubUser?.trim() ? request.githubUser.trim() : null,
          provider: request.provider,
          adapter: request.adapter,
          mode: request.mode,
          createNewRepository: request.createNewRepository ?? false,
          targetDirectory: request.targetDirectory?.trim() ? request.targetDirectory.trim() : null,
          workspaceId: request.workspaceId?.trim() ? request.workspaceId.trim() : null,
          ...(request.channel ? { channel: request.channel } : {}),
        }),
        action: "Start provisioning job",
        fallbackMessage: "Failed to start provisioning job",
      }));
      setJobId(nextSnapshot.job.config.id);
      activeJobIdRef.current = nextSnapshot.job.config.id;
      setInitialSnapshot(nextSnapshot);
      setNotFoundJobId(null);
      return nextSnapshot;
    } catch (nextError) {
      setError(String(nextError));
      return null;
    } finally {
      setStarting(false);
    }
  }, [mutate]);

  const cancelJob = useCallback(async (): Promise<boolean> => {
    if (!activeJobId) {
      return false;
    }

    try {
      setError(null);
      await mutate((signal) => apiRequest(`/api/provisioning-jobs/${encodeURIComponent(activeJobId)}`, {
        signal,
        method: "DELETE",
        action: "Cancel provisioning job",
        fallbackMessage: "Failed to cancel provisioning job",
      }));
      await refreshJob();
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    }
  }, [activeJobId, mutate, refreshJob]);

  const dismissJob = useCallback(async (jobIdOverride?: string): Promise<boolean> => {
    const jobId = jobIdOverride ?? activeJobIdRef.current;
    if (!jobId) {
      return false;
    }

    try {
      setError(null);
      await mutate((signal) => dismissProvisioningJobRequest(jobId, { signal }));
      if (activeJobIdRef.current === jobId) {
        clearActiveJob();
      }
      return true;
    } catch (nextError) {
      setError(String(nextError));
      return false;
    }
  }, [clearActiveJob, mutate]);

  const dismissAllJobs = useCallback(async (): Promise<DismissAllProvisioningJobsResult> => {
    if (dismissingAllJobsRef.current) {
      return {
        dismissedJobIds: [],
        failedJobIds: [],
      };
    }

    const jobIds = jobs
      .filter(isDismissibleProvisioningJob)
      .map((job) => job.config.id);
    if (jobIds.length === 0) {
      return {
        dismissedJobIds: [],
        failedJobIds: [],
      };
    }

    dismissingAllJobsRef.current = true;
    setDismissingAllJobs(true);
    setError(null);
    const controller = new AbortController();
    dismissingAllControllerRef.current = controller;
    try {
      const results = await mutate((signal) => Promise.allSettled(
        jobIds.map((jobId) => dismissProvisioningJobRequest(jobId, {
          signal: AbortSignal.any([signal, controller.signal]),
          retryOnReadiness: true,
        })),
      ));
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
      return { dismissedJobIds, failedJobIds };
    } finally {
      if (dismissingAllControllerRef.current === controller) {
        dismissingAllControllerRef.current = null;
      }
      dismissingAllJobsRef.current = false;
      setDismissingAllJobs(false);
    }
  }, [clearActiveJob, jobs, mutate]);

  useEffect(() => {
    return () => {
      dismissingAllControllerRef.current?.abort();
      dismissingAllControllerRef.current = null;
    };
  }, []);

  return {
    jobs,
    jobsLoading: jobsQuery.loading,
    jobsError: jobsQuery.error ? String(jobsQuery.error) : null,
    activeJobId,
    snapshot,
    logs: snapshot?.logs ?? [],
    loading,
    notFoundJobId,
    starting,
    error: error ?? (snapshotError ? String(snapshotError) : null),
    websocketStatus,
    startJob,
    openJob,
    refreshJobs,
    refreshJob,
    cancelJob,
    dismissJob,
    dismissAllJobs,
    dismissingAllJobs,
    clearActiveJob,
  };
}
