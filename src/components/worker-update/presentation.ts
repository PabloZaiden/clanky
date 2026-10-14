import type {
  WorkerUpdateJob,
  WorkerUpdateStep,
} from "@/shared/worker-update";

export function getWorkerUpdateStepLabel(step: WorkerUpdateStep): string {
  return step === "update" ? "Clanky update" : "Worker service restart";
}

export function getWorkerUpdateProgressLabel(job: WorkerUpdateJob): string {
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
    case "interrupted":
      return "Interrupted";
  }
}
