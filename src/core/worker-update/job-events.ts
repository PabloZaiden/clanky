import { workerUpdateEventEmitter } from "../event-emitter";
import type { WorkerUpdateJob } from "@/shared/worker-update";

export function emitWorkerUpdateJobChanged(
  job: WorkerUpdateJob,
  userId: string,
): void {
  workerUpdateEventEmitter.emit({
    type: "worker-update.changed",
    workerUpdateJobId: job.config.id,
    timestamp: job.state.updatedAt,
  }, { userId });
}

export function emitWorkerUpdateJobDeleted(
  workerUpdateJobId: string,
  userId: string,
): void {
  workerUpdateEventEmitter.emit({
    type: "worker-update.deleted",
    workerUpdateJobId,
    timestamp: new Date().toISOString(),
  }, { userId });
}
