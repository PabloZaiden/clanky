import { describe, expect, test } from "bun:test";
import {
  createInterruptibleOperationCoordinator,
} from "../../src/core/interruptible-operation";

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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function createTestCoordinator(
  controller: AbortController,
  options: {
    interrupt?: () => Promise<void>;
    settlementTimeoutMs?: number;
  } = {},
): {
  coordinator: ReturnType<typeof createInterruptibleOperationCoordinator>;
  interruptCalls: number;
  interruptErrors: unknown[];
  timeoutPhases: Array<string | undefined>;
} {
  let interruptCalls = 0;
  const interruptErrors: unknown[] = [];
  const timeoutPhases: Array<string | undefined> = [];
  const coordinator = createInterruptibleOperationCoordinator({
    signal: controller.signal,
    interrupt: options.interrupt ?? (async () => {
      interruptCalls += 1;
    }),
    settlementTimeoutMs: options.settlementTimeoutMs ?? 5_000,
    createAbortError: () => new Error("operation cancelled"),
    onInterruptError: (error) => {
      interruptErrors.push(error);
    },
    onSettlementTimeout: (phaseName) => {
      timeoutPhases.push(phaseName);
    },
  });
  return {
    coordinator,
    get interruptCalls() {
      return interruptCalls;
    },
    interruptErrors,
    timeoutPhases,
  };
}

describe("interruptible operation coordinator", () => {
  test("completes normally and removes the abort listener before later cancellation", async () => {
    const controller = new AbortController();
    const testCoordinator = createTestCoordinator(controller);

    await expect(
      testCoordinator.coordinator.runPhase(async () => "complete", "send"),
    ).resolves.toBe("complete");
    await testCoordinator.coordinator.dispose();

    controller.abort();

    expect(testCoordinator.interruptCalls).toBe(0);
    expect(testCoordinator.interruptErrors).toHaveLength(0);
  });

  test("does not start a phase after an already-observed abort", async () => {
    const controller = new AbortController();
    const testCoordinator = createTestCoordinator(controller);
    let started = false;

    const phase = testCoordinator.coordinator.runPhase(async () => {
      started = true;
      return "unexpected";
    }, "send");
    controller.abort();

    await expect(phase).rejects.toThrow("operation cancelled");
    await testCoordinator.coordinator.dispose();

    expect(started).toBe(false);
    expect(testCoordinator.interruptCalls).toBe(1);
  });

  test("handles a pre-aborted coordinator without starting a phase", async () => {
    const controller = new AbortController();
    controller.abort();
    const testCoordinator = createTestCoordinator(controller);

    await testCoordinator.coordinator.dispose();

    expect(testCoordinator.interruptCalls).toBe(1);
    expect(testCoordinator.interruptErrors).toHaveLength(0);
  });

  test("interrupts an active phase once and performs one late interrupt after settlement", async () => {
    const controller = new AbortController();
    const testCoordinator = createTestCoordinator(controller);
    const deferred = createDeferred<string>();
    let started = false;

    const phase = testCoordinator.coordinator.runPhase(async () => {
      started = true;
      return await deferred.promise;
    }, "send");
    await flushMicrotasks();
    expect(started).toBe(true);

    controller.abort();
    deferred.resolve("late");

    await expect(phase).rejects.toThrow("operation cancelled");
    await testCoordinator.coordinator.dispose();

    expect(testCoordinator.interruptCalls).toBe(2);
    expect(testCoordinator.interruptErrors).toHaveLength(0);
  });

  test("bounds a passive phase settlement without scheduling a late interrupt", async () => {
    const controller = new AbortController();
    const testCoordinator = createTestCoordinator(controller);
    const deferred = createDeferred<string>();

    const phase = testCoordinator.coordinator.runPhase(
      () => deferred.promise,
      "wait",
      { allowLateInterrupt: false },
    );
    await flushMicrotasks();
    controller.abort();
    deferred.resolve("settled");

    await expect(phase).rejects.toThrow("operation cancelled");
    await testCoordinator.coordinator.dispose();

    expect(testCoordinator.interruptCalls).toBe(1);
    expect(testCoordinator.timeoutPhases).toHaveLength(0);
  });

  test("does not replace an operation failure or interrupt after normal failure", async () => {
    const controller = new AbortController();
    const testCoordinator = createTestCoordinator(controller);
    const failure = new Error("operation failed");

    await expect(
      testCoordinator.coordinator.runPhase(async () => {
        throw failure;
      }, "send"),
    ).rejects.toBe(failure);
    await testCoordinator.coordinator.dispose();

    controller.abort();

    expect(testCoordinator.interruptCalls).toBe(0);
  });

  test("reports an interrupt failure without rejecting the cancellation path", async () => {
    const controller = new AbortController();
    const interruptFailure = new Error("interrupt failed");
    const testCoordinator = createTestCoordinator(controller, {
      interrupt: async () => {
        throw interruptFailure;
      },
    });

    const phase = testCoordinator.coordinator.runPhase(async () => "complete", "send");
    controller.abort();

    await expect(phase).rejects.toThrow("operation cancelled");
    await testCoordinator.coordinator.dispose();

    expect(testCoordinator.interruptErrors).toEqual([interruptFailure]);
  });

  test("reports a settlement timeout and still handles a later phase settlement", async () => {
    const controller = new AbortController();
    const testCoordinator = createTestCoordinator(controller, {
      settlementTimeoutMs: 0,
    });
    const deferred = createDeferred<string>();

    const phase = testCoordinator.coordinator.runPhase(
      () => deferred.promise,
      "wait",
    );
    await flushMicrotasks();
    controller.abort();

    await expect(phase).rejects.toThrow("operation cancelled");
    expect(testCoordinator.timeoutPhases).toEqual(["wait"]);
    expect(testCoordinator.interruptCalls).toBe(1);

    deferred.resolve("late");
    await flushMicrotasks();
    await testCoordinator.coordinator.dispose();

    expect(testCoordinator.interruptCalls).toBe(2);
  });
});
