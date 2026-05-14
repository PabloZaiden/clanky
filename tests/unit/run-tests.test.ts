import { describe, expect, test } from "bun:test";
import {
  buildEnv,
  createRetryBucket,
  formatBucketHeader,
  formatBucketOutput,
  runTestBuckets,
  shouldRetryFailedBuckets,
  withMaxConcurrency,
} from "../../scripts/run-tests";

describe("run-tests helpers", () => {
  test("defaults the runner log level to fatal without mutating explicit values", () => {
    expect(buildEnv({ CI: "true" })["RALPHER_LOG_LEVEL"]).toBe("fatal");
    expect(buildEnv({ RALPHER_LOG_LEVEL: "debug" })["RALPHER_LOG_LEVEL"]).toBe("debug");
  });

  test("retries failed buckets only in CI unless overridden", () => {
    expect(shouldRetryFailedBuckets({ CI: "true" })).toBe(true);
    expect(shouldRetryFailedBuckets({})).toBe(false);
    expect(shouldRetryFailedBuckets({ CI: "true", RALPHER_TEST_RETRY_FAILED_BUCKETS: "0" })).toBe(false);
    expect(shouldRetryFailedBuckets({ RALPHER_TEST_RETRY_FAILED_BUCKETS: "1" })).toBe(true);
  });

  test("forces retry buckets to run with max concurrency 1", () => {
    const args = ["test", "--timeout", "30000", "--max-concurrency", "2", "tests/unit/a.test.ts"];
    expect(withMaxConcurrency(args, 1)).toEqual([
      "test",
      "--timeout",
      "30000",
      "--max-concurrency",
      "1",
      "tests/unit/a.test.ts",
    ]);

    expect(createRetryBucket({
      id: "unit-1",
      label: "tests/unit shard 1",
      args,
      weight: 10,
    }).args).toEqual([
      "test",
      "--timeout",
      "30000",
      "--max-concurrency",
      "1",
      "tests/unit/a.test.ts",
    ]);
  });

  test("suppresses passing output but preserves failure diagnostics", () => {
    const passingResult = {
      bucket: {
        id: "unit-1",
        label: "tests/unit shard 1",
        args: ["test"],
        weight: 10,
      },
      exitCode: 0,
      output: "73 pass\n0 fail",
      elapsedMs: 3200,
    };
    const failedResult = {
      ...passingResult,
      exitCode: 1,
      output: "error: timed out",
      elapsedMs: 47000,
    };
    const retryResult = {
      ...passingResult,
      elapsedMs: 9100,
    };
    const failedRetryResult = {
      ...passingResult,
      exitCode: 1,
      output: "retry error",
      elapsedMs: 8200,
    };

    expect(formatBucketHeader(passingResult)).toBe("== tests/unit shard 1 PASS (3.2s) ==");
    expect(formatBucketOutput(passingResult)).toBeNull();

    expect(formatBucketHeader(failedResult)).toBe("== tests/unit shard 1 FAIL (47.0s) ==");
    expect(formatBucketOutput(failedResult)).toBe("error: timed out");

    expect(formatBucketHeader(failedResult, retryResult)).toBe(
      "== tests/unit shard 1 PASS after retry (9.1s retry, 47.0s initial fail) ==",
    );
    expect(formatBucketOutput(failedResult, retryResult)).toBeNull();

    expect(formatBucketHeader(failedResult, failedRetryResult)).toBe(
      "== tests/unit shard 1 FAIL after retry (8.2s retry, 47.0s initial fail) ==",
    );
    expect(formatBucketOutput(failedResult, failedRetryResult)).toBe([
      "Initial attempt output:",
      "error: timed out",
      "",
      "Retry output:",
      "retry error",
    ].join("\n"));

    expect(formatBucketOutput(failedResult, {
      ...failedRetryResult,
      output: "error: timed out",
    })).toBe([
      "Initial attempt output:",
      "error: timed out",
      "",
      "Retry output (matched initial attempt):",
      "error: timed out",
    ].join("\n"));
  });

  test("runTestBuckets succeeds when a failed bucket passes on retry", async () => {
    const logs: string[] = [];
    const seenArgs: string[][] = [];
    const bucket = {
      id: "unit-1",
      label: "tests/unit shard 1",
      args: ["test", "--timeout", "30000", "--max-concurrency", "2", "tests/unit/a.test.ts"],
      weight: 10,
    };
    let runCount = 0;

    const exitCode = await runTestBuckets("all", { CI: "true" }, {
      buildBuckets: async () => [bucket],
      runBucket: async (nextBucket) => {
        seenArgs.push(nextBucket.args);
        runCount += 1;
        if (runCount === 1) {
          return {
            bucket: nextBucket,
            exitCode: 1,
            output: "error: timed out",
            elapsedMs: 47_000,
          };
        }
        return {
          bucket: nextBucket,
          exitCode: 0,
          output: "",
          elapsedMs: 9_100,
        };
      },
      log: (message) => {
        logs.push(message);
      },
    });

    expect(exitCode).toBe(0);
    expect(seenArgs).toEqual([
      ["test", "--timeout", "30000", "--max-concurrency", "2", "tests/unit/a.test.ts"],
      ["test", "--timeout", "30000", "--max-concurrency", "1", "tests/unit/a.test.ts"],
    ]);
    expect(logs).toContain("== tests/unit shard 1 PASS after retry (9.1s retry, 47.0s initial fail) ==");
    expect(logs.some((line) =>
      line.startsWith("Test run completed in ") && line.includes("after retrying 1 failed bucket(s).")
    )).toBe(true);
  });

  test("runTestBuckets serializes frontend buckets after parallel backend buckets", async () => {
    const startedBuckets: string[] = [];
    const finishedBuckets: string[] = [];
    const unblockBackend = Promise.withResolvers<void>();
    const buckets = [
      {
        id: "frontend-components-1",
        label: "tests/frontend/components shard 1",
        args: ["test", "--max-concurrency", "1", "tests/frontend/components/a.test.tsx"],
        weight: 10,
      },
      {
        id: "frontend-hooks-1",
        label: "tests/frontend/hooks shard 1",
        args: ["test", "--max-concurrency", "1", "tests/frontend/hooks/a.test.ts"],
        weight: 9,
      },
      {
        id: "unit-1",
        label: "tests/unit shard 1",
        args: ["test", "--max-concurrency", "2", "tests/unit/a.test.ts"],
        weight: 8,
      },
      {
        id: "api-1",
        label: "tests/api shard 1",
        args: ["test", "--max-concurrency", "2", "tests/api/a.test.ts"],
        weight: 7,
      },
    ];

    const exitCodePromise = runTestBuckets("all", { RALPHER_TEST_MAX_WORKERS: "2" }, {
      buildBuckets: async () => buckets,
      runBucket: async (bucket) => {
        startedBuckets.push(bucket.id);
        if (!bucket.id.startsWith("frontend-")) {
          await unblockBackend.promise;
        }
        finishedBuckets.push(bucket.id);
        return {
          bucket,
          exitCode: 0,
          output: "",
          elapsedMs: 1,
        };
      },
      log: () => {},
    });

    await Bun.sleep(0);
    expect(startedBuckets).toEqual(["unit-1", "api-1"]);

    unblockBackend.resolve();
    const exitCode = await exitCodePromise;

    expect(exitCode).toBe(0);
    expect(finishedBuckets).toEqual([
      "unit-1",
      "api-1",
      "frontend-components-1",
      "frontend-hooks-1",
    ]);
  });

  test("runTestBuckets fails when a retried bucket still fails", async () => {
    const logs: string[] = [];
    const bucket = {
      id: "unit-1",
      label: "tests/unit shard 1",
      args: ["test", "--timeout", "30000", "--max-concurrency", "2", "tests/unit/a.test.ts"],
      weight: 10,
    };
    let runCount = 0;

    const exitCode = await runTestBuckets("all", { CI: "true" }, {
      buildBuckets: async () => [bucket],
      runBucket: async (nextBucket) => {
        runCount += 1;
        if (runCount === 1) {
          return {
            bucket: nextBucket,
            exitCode: 1,
            output: "error: timed out",
            elapsedMs: 47_000,
          };
        }
        return {
          bucket: nextBucket,
          exitCode: 1,
          output: "retry error",
          elapsedMs: 8_200,
        };
      },
      log: (message) => {
        logs.push(message);
      },
    });

    expect(exitCode).toBe(1);
    expect(logs).toContain("== tests/unit shard 1 FAIL after retry (8.2s retry, 47.0s initial fail) ==");
    expect(logs).toContain([
      "Initial attempt output:",
      "error: timed out",
      "",
      "Retry output:",
      "retry error",
    ].join("\n"));
    expect(logs.some((line) =>
      line.startsWith("Test run completed in ") && line.includes("after retrying 1 failed bucket(s).")
    )).toBe(true);
  });
});
