import { describe, expect, test } from "bun:test";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { listActiveWorkerRegistrations } from "../../src/persistence/mesh";
import { MeshHealthService } from "../../src/core/mesh-health-service";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

describe("Mesh health service", () => {
  // This lifecycle regression protects the external worker probe from
  // duplicate work when startup and a capability retry overlap.
  test("shares a concurrent full refresh probe with a targeted refresh", async () => {
    const probe = createDeferred<void>();
    let probeCount = 0;
    const user: CurrentUser = {
      id: "user-1",
      username: "user-1",
      role: "user",
      isOwner: false,
      isAdmin: false,
    };
    const service = new MeshHealthService({
      runForEachActiveUser: async (callback) => await callback(user),
      listActiveWorkerRegistrations: async () =>
        [{ workerNodeId: "worker-1" }] as Awaited<
          ReturnType<typeof listActiveWorkerRegistrations>
        >,
      checkWorkerReachability: async () => {
        probeCount += 1;
        await probe.promise;
      },
    });

    const targetedRefresh = service.refreshWorker("user-1", "worker-1");
    const fullRefresh = service.refreshAllWorkers();

    expect(probeCount).toBe(1);
    probe.resolve();
    await Promise.all([targetedRefresh, fullRefresh]);
    expect(probeCount).toBe(1);
  });
});
