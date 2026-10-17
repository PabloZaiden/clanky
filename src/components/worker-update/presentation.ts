import type {
  WorkerUpdateJob,
  WorkerUpdateStep,
} from "@/shared/worker-update";

export function getWorkerUpdateStepLabel(step: WorkerUpdateStep): string {
  return step === "update" ? "Clanky update" : "Worker service restart";
}

export function getWorkerUpdateWorkerName(job: WorkerUpdateJob): string {
  return job.config.workerName === job.config.workerNodeId ? "Worker" : job.config.workerName;
}

export function getWorkerUpdateProgressLabel(job: WorkerUpdateJob): string {
  switch (job.state.status) {
    case "not_started": return "Not started";
    case "connection_failed": return "Could not connect";
    case "unconfirmed": return "Outcome unconfirmed";
    case "interrupted": return "Execution interrupted";
    case "connecting": return "Connecting to worker";
    case "verifying": return "Verifying worker restart";
  }
  if (job.state.currentStep) {
    return getWorkerUpdateStepLabel(job.state.currentStep);
  }
  if (job.state.error?.step) {
    return `Stopped during ${getWorkerUpdateStepLabel(job.state.error.step)}`;
  }
  switch (job.state.status) {
    case "pending":
      return "Waiting to start";
    case "running":
      return "Preparing worker";
    case "completed":
      return "Update and restart completed";
    case "failed":
      return "Failed";
  }
}
