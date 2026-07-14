import { provisioningEventEmitter } from "../event-emitter";
import type { ProvisioningJob, ProvisioningJobError } from "@/shared";

export function emitJobStarted(job: ProvisioningJob): void {
  provisioningEventEmitter.emit({
    type: "provisioning.started",
    provisioningJobId: job.config.id,
    job: structuredClone(job),
    timestamp: job.state.updatedAt,
  });
}

export function emitJobCompleted(job: ProvisioningJob): void {
  provisioningEventEmitter.emit({
    type: "provisioning.completed",
    provisioningJobId: job.config.id,
    job: structuredClone(job),
    timestamp: job.state.updatedAt,
  });
}

export function emitJobFailed(job: ProvisioningJob, error: ProvisioningJobError): void {
  provisioningEventEmitter.emit({
    type: "provisioning.failed",
    provisioningJobId: job.config.id,
    job: structuredClone(job),
    error,
    timestamp: job.state.updatedAt,
  });
}

export function emitJobCancelled(job: ProvisioningJob): void {
  provisioningEventEmitter.emit({
    type: "provisioning.cancelled",
    provisioningJobId: job.config.id,
    job: structuredClone(job),
    timestamp: job.state.updatedAt,
  });
}
