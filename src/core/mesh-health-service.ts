/**
 * Coordinates best-effort Mesh worker health refreshes.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { runForEachActiveUser } from "./background-users";
import { meshManager } from "./mesh-manager";

const log = createLogger("core:mesh-health-service");

export class MeshHealthService {
  private allWorkersRefresh?: Promise<void>;
  private readonly workerRefreshes = new Map<string, Promise<void>>();

  async refreshAllWorkers(): Promise<void> {
    if (this.allWorkersRefresh) {
      return await this.allWorkersRefresh;
    }

    const refresh = runForEachActiveUser(async (user) => {
      try {
        await meshManager.checkWorkerHealth(user.id);
      } catch (error) {
        log.warn("Mesh worker health refresh failed for a user", {
          userId: user.id,
          error: String(error),
        });
      }
    });
    const trackedRefresh = refresh.finally(() => {
      if (this.allWorkersRefresh === trackedRefresh) {
        this.allWorkersRefresh = undefined;
      }
    });
    this.allWorkersRefresh = trackedRefresh;
    return await trackedRefresh;
  }

  async refreshWorker(userId: string, workerNodeId: string): Promise<void> {
    const key = `${userId}:${workerNodeId}`;
    const existingRefresh = this.workerRefreshes.get(key);
    if (existingRefresh) {
      return await existingRefresh;
    }

    const refresh = meshManager.checkWorkerReachability(userId, workerNodeId);
    const trackedRefresh = refresh.finally(() => {
      if (this.workerRefreshes.get(key) === trackedRefresh) {
        this.workerRefreshes.delete(key);
      }
    });
    this.workerRefreshes.set(key, trackedRefresh);
    return await trackedRefresh;
  }

  scheduleRefreshAllWorkers(reason: string): void {
    // Health reconciliation must not delay server startup or relay reconnects.
    void this.refreshAllWorkers().catch((error) => {
      log.error("Scheduled Mesh worker health refresh failed", {
        reason,
        error: String(error),
      });
    });
  }
}

export const meshHealthService = new MeshHealthService();
