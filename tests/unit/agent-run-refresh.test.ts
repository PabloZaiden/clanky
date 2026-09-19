import { describe, expect, test } from "bun:test";
import { createAgentRunRefreshCoordinator } from "../../src/lib/agent-run-refresh";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

describe("agent run refresh coordinator", () => {
  test("keeps a superseded response from replacing newer loaded data", async () => {
    const coordinator = createAgentRunRefreshCoordinator<string[]>();
    const oldResponse = createDeferred<string[]>();
    const newResponse = createDeferred<string[]>();
    const loaded: string[][] = [];

    const oldRefresh = coordinator.refresh("agent-1", {
      load: async () => await oldResponse.promise,
      onLoaded: (runs) => loaded.push(runs),
    });
    const newRefresh = coordinator.refresh("agent-1", {
      force: true,
      load: async () => await newResponse.promise,
      onLoaded: (runs) => loaded.push(runs),
    });

    newResponse.resolve(["new"]);
    await newRefresh;
    oldResponse.resolve(["old"]);
    await oldRefresh;

    expect(loaded).toEqual([["new"]]);
  });

  test("invalidates deleted or unmounted agent refreshes without surfacing late errors", async () => {
    const coordinator = createAgentRunRefreshCoordinator<string[]>();
    const deletedResponse = createDeferred<string[]>();
    const deletedLoaded: string[][] = [];
    const deletedErrors: unknown[] = [];

    const deletedRefresh = coordinator.refresh("deleted-agent", {
      load: async () => await deletedResponse.promise,
      onLoaded: (runs) => deletedLoaded.push(runs),
      onError: (error) => deletedErrors.push(error),
    });
    coordinator.invalidate("deleted-agent");
    deletedResponse.resolve(["late"]);
    await deletedRefresh;

    const unmountedResponse = createDeferred<string[]>();
    const unmountedErrors: unknown[] = [];
    const unmountedRefresh = coordinator.refresh("unmounted-agent", {
      load: async () => await unmountedResponse.promise,
      onLoaded: () => {},
      onError: (error) => unmountedErrors.push(error),
    });
    coordinator.setMounted(false);
    unmountedResponse.reject(new Error("late failure"));
    await unmountedRefresh;

    expect(deletedLoaded).toHaveLength(0);
    expect(deletedErrors).toHaveLength(0);
    expect(unmountedErrors).toHaveLength(0);
  });

  test("deduplicates ordinary refreshes and preserves their loaded payload", async () => {
    const coordinator = createAgentRunRefreshCoordinator<string[]>();
    const response = createDeferred<string[]>();
    const loaded: string[][] = [];

    const firstRefresh = coordinator.refresh("agent-1", {
      load: async () => await response.promise,
      onLoaded: (runs) => loaded.push(runs),
    });
    const secondRefresh = coordinator.refresh("agent-1", {
      load: async () => ["unexpected"],
      onLoaded: (runs) => loaded.push(runs),
    });

    expect(secondRefresh).toBe(firstRefresh);
    response.resolve(["newest", "oldest"]);
    await Promise.all([firstRefresh, secondRefresh]);

    expect(loaded).toEqual([["newest", "oldest"]]);
  });

  test("surfaces current failures while ignoring superseded failures", async () => {
    const coordinator = createAgentRunRefreshCoordinator<string[]>();
    const currentFailure = new Error("current failure");
    const currentErrors: unknown[] = [];
    const currentRefresh = coordinator.refresh("agent-1", {
      load: async () => {
        throw currentFailure;
      },
      onLoaded: () => {},
      onError: (error) => currentErrors.push(error),
    });
    await currentRefresh;

    const oldResponse = createDeferred<string[]>();
    const replacementResponse = createDeferred<string[]>();
    const supersededErrors: unknown[] = [];
    const oldRefresh = coordinator.refresh("agent-2", {
      load: async () => await oldResponse.promise,
      onLoaded: () => {},
      onError: (error) => supersededErrors.push(error),
    });
    const replacementRefresh = coordinator.refresh("agent-2", {
      force: true,
      load: async () => await replacementResponse.promise,
      onLoaded: () => {},
      onError: (error) => supersededErrors.push(error),
    });
    oldResponse.reject(new Error("superseded failure"));
    replacementResponse.resolve(["current"]);
    await Promise.all([oldRefresh, replacementRefresh]);

    expect(currentErrors).toEqual([currentFailure]);
    expect(supersededErrors).toHaveLength(0);
  });
});
