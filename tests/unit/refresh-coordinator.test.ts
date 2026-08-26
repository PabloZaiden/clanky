import { describe, expect, test } from "bun:test";
import { createRefreshCoordinator } from "../../src/lib/refresh-coordinator";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("refresh coordinator", () => {
  test("shares one in-flight refresh", async () => {
    const coordinator = createRefreshCoordinator<string>();
    const pending = deferred<string>();
    let calls = 0;

    const first = coordinator.run(async () => {
      calls += 1;
      return await pending.promise;
    });
    const second = coordinator.run(async () => {
      calls += 1;
      return "unexpected";
    });

    expect(second).toBe(first);
    expect(calls).toBe(0);
    pending.resolve("refreshed");

    expect(await first).toBe("refreshed");
    expect(calls).toBe(1);
  });

  test("reset allows a new identity to start without losing the replacement", async () => {
    const coordinator = createRefreshCoordinator<string>();
    const firstPending = deferred<string>();
    const secondPending = deferred<string>();
    let calls = 0;

    const first = coordinator.run(async () => {
      calls += 1;
      return await firstPending.promise;
    });
    coordinator.reset();
    const second = coordinator.run(async () => {
      calls += 1;
      return await secondPending.promise;
    });

    firstPending.resolve("old");
    secondPending.resolve("new");

    expect(await first).toBe("old");
    expect(await second).toBe("new");
    expect(calls).toBe(2);
    expect(coordinator.run(() => "next")).not.toBe(second);
  });
});
