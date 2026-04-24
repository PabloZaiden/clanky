import { describe, expect, test } from "bun:test";
import {
  buildEnv,
  createRetryBucket,
  formatBucketHeader,
  formatBucketOutput,
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
  });
});
