import { workerUpdateEventEmitter } from "../event-emitter";
import type { WorkerUpdateJob } from "@/shared/worker-update";

export function emitWorkerUpdateJobChanged(
  job: WorkerUpdateJob,
  userId: string,
  timestamp: string = job.state.updatedAt,
): void {
  workerUpdateEventEmitter.emit({
    type: "worker-update.changed",
    workerUpdateJobId: job.config.id,
    timestamp,
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
