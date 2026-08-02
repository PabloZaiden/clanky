import { createLogger } from "@pablozaiden/webapp/server";
import { deliverMeshSyncOutbox } from "./mesh-sync-manager";

const log = createLogger("core:mesh-sync-worker");
const MESH_SYNC_INTERVAL_MS = 2_000;

class MeshSyncWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, MESH_SYNC_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await deliverMeshSyncOutbox();
    } catch (error) {
      log.error("Mesh sync worker iteration failed", { error: String(error) });
    } finally {
      this.running = false;
    }
  }
}

export const meshSyncWorker = new MeshSyncWorker();
