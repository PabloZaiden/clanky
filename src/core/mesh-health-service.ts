/**
 * Coordinates best-effort Mesh worker health refreshes.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import {
  listActiveWorkerRegistrations,
} from "../persistence/mesh";
import { runForEachActiveUser } from "./background-users";
import { meshManager } from "./mesh-manager";

const log = createLogger("core:mesh-health-service");

export interface MeshHealthServiceDependencies {
  runForEachActiveUser?: (
    callback: (user: CurrentUser) => Promise<void>,
  ) => Promise<void>;
  listActiveWorkerRegistrations?: typeof listActiveWorkerRegistrations;
  checkWorkerReachability?: (
    userId: string,
    workerNodeId: string,
  ) => Promise<void>;
}

export class MeshHealthService {
  private allWorkersRefresh?: Promise<void>;
  private readonly workerRefreshes = new Map<string, Promise<void>>();
  private readonly runForEachActiveUser: (
    callback: (user: CurrentUser) => Promise<void>,
  ) => Promise<void>;
  private readonly listActiveWorkerRegistrations: typeof listActiveWorkerRegistrations;
  private readonly checkWorkerReachability: (
    userId: string,
    workerNodeId: string,
  ) => Promise<void>;

  constructor(dependencies: MeshHealthServiceDependencies = {}) {
    this.runForEachActiveUser =
      dependencies.runForEachActiveUser ?? runForEachActiveUser;
    this.listActiveWorkerRegistrations =
      dependencies.listActiveWorkerRegistrations ?? listActiveWorkerRegistrations;
    this.checkWorkerReachability =
      dependencies.checkWorkerReachability
      ?? (async (userId, workerNodeId) => {
        await meshManager.checkWorkerReachability(userId, workerNodeId);
      });
  }

  async refreshAllWorkers(): Promise<void> {
    if (this.allWorkersRefresh) {
      return await this.allWorkersRefresh;
    }

    const refresh = this.runForEachActiveUser(async (user) => {
      try {
        const workers = await this.listActiveWorkerRegistrations(user.id);
        await Promise.all(workers.map(async (worker) => {
          try {
            await this.refreshWorker(user.id, worker.workerNodeId);
          } catch (error) {
            log.warn("Mesh worker health refresh failed", {
              userId: user.id,
              workerNodeId: worker.workerNodeId,
              error: String(error),
            });
          }
        }));
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

    const refresh = this.checkWorkerReachability(userId, workerNodeId);
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
